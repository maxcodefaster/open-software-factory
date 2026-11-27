package connector

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type childRuntime struct {
	assignment     Assignment
	control        *controlConnection
	httpClient     *http.Client
	streams        map[string]*websocket.Conn
	httpCancels    map[string]context.CancelFunc
	agentMutations map[string]bool
	agentRequests  chan func()
	agentUncertain bool
	streamLock     sync.Mutex
	controlLock    sync.RWMutex
	processes      *processManager
	terminals      *terminalManager
	languages      *languageManager
	commands       *commandManager
	files          *containerFileManager
}

func RunChild(ctx context.Context, assignment Assignment, token string) error {
	ctx, cancelChild := context.WithCancel(ctx)
	defer cancelChild()
	if token == "" {
		return errors.New("Factory connector token is required")
	}
	resetStartupTimings()
	var backoff reconnectBackoff
	control := dialInitialControl(ctx, assignment, token, &backoff)
	if control == nil {
		return nil
	}
	fail := func(err error) error {
		control.Write(Message{Type: "status", Phase: "failed", Error: err.Error()})
		control.Close()
		return err
	}
	output := io.Writer(os.Stdout)
	if assignment.EnvironmentVersion != nil {
		output = io.Discard
	}
	processes := newProcessManager(ctx, assignment, output)
	defer processes.StopAll()
	if !processes.Development() {
		// Development announces its independent Terminal immediately below.
		// Non-development Apps can take time to become healthy; publish their
		// real process state and output without claiming channel readiness.
		processes.Connect(control)
		defer processes.Connect(nil)
	}
	finishProcesses := startupPhase("process-start")
	processErr := processes.StartAll()
	finishProcesses()
	if processErr != nil {
		return fail(processErr)
	}
	finishReadiness := startupPhase("channel-readiness")
	readinessErr := waitForChannels(ctx, assignment, processes)
	finishReadiness()
	if readinessErr != nil {
		return fail(readinessErr)
	}
	processes.Supervise()
	runtime := &childRuntime{
		assignment: assignment,
		httpClient: &http.Client{
			Transport: &http.Transport{ResponseHeaderTimeout: 60 * time.Second},
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		streams:       make(map[string]*websocket.Conn),
		processes:     processes,
		agentRequests: make(chan func(), 16),
	}
	agentDone := make(chan struct{})
	go func() {
		defer close(agentDone)
		runtime.forwardAgentRequests(ctx)
	}()
	defer func() {
		cancelChild()
		runtime.setControl(nil)
		control.Close()
		<-agentDone
	}()
	runtime.commands = newCommandManager(ctx, assignment, runtime.send)
	defer runtime.commands.Close()
	if processes.Development() {
		var err error
		runtime.files, err = newContainerFileManager("/")
		if err != nil {
			return fail(errors.New("container file access could not initialize"))
		}
		defer runtime.files.Close()
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					runtime.files.Sweep()
				}
			}
		}()
	}
	runtime.terminals = newTerminalManager(ctx, assignment, runtime.send)
	go runtime.terminals.Watch()
	defer runtime.terminals.CloseAll()
	runtime.languages = newLanguageManager(ctx, assignment, runtime.send)
	defer runtime.languages.CloseAll()
	for {
		runtime.languages.Reconnect()
		runtime.setControl(control)
		terminals := runtime.terminals.Observation()
		commandCount := runtime.commands.ActiveCount()
		if err := control.Write(Message{
			Type:             "hello",
			Role:             "child",
			AttemptID:        assignment.RuntimeAttemptID,
			Generation:       assignment.Generation,
			Channels:         assignment.Channels,
			TerminalCount:    terminals.TerminalCount,
			TerminalBusy:     terminals.TerminalBusy,
			TerminalRevision: terminals.TerminalRevision,
			CommandCount:     &commandCount,
		}); err != nil {
			control.Close()
		} else {
			processes.Connect(control)
			runtime.commands.Reconnect()
			readErrors := make(chan error, 1)
			go func() { readErrors <- runtime.readLoop(ctx, control) }()
			select {
			case <-ctx.Done():
				processes.Connect(nil)
				runtime.setControl(nil)
				control.Close()
				return nil
			case err := <-processes.Fatal():
				processes.Connect(nil)
				runtime.setControl(nil)
				return fail(err)
			case <-readErrors:
				processes.Connect(nil)
				runtime.setControl(nil)
				runtime.disconnectStreams()
				control.Close()
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case err := <-processes.Fatal():
			return err
		case <-time.After(250 * time.Millisecond):
		}
		var err error
		control, err = reconnectControl(ctx, assignment, token, &backoff, processes.Fatal())
		if control == nil {
			return err
		}
	}
}

func dialInitialControl(ctx context.Context, assignment Assignment, token string, backoff *reconnectBackoff) *controlConnection {
	for {
		control, err := dialControl(ctx, assignment, "child", token)
		if err == nil {
			backoff.Reset()
			return control
		}
		// Injection can finish while Factory is restarting. The admitted child
		// must survive first-connect downtime just as it survives later disconnects.
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff.Next()):
		}
	}
}

func reconnectControl(ctx context.Context, assignment Assignment, token string, backoff *reconnectBackoff, fatal <-chan error) (*controlConnection, error) {
	for {
		if gate := assignment.NativeWriters(); gate != nil && gate.Frozen() {
			if err := gate.Resume(ctx); err != nil {
				select {
				case <-ctx.Done():
					return nil, nil
				case <-time.After(backoff.Next()):
					continue
				}
			}
		}
		control, err := dialControl(ctx, assignment, "child", token)
		if err == nil {
			backoff.Reset()
			return control, nil
		}
		select {
		case <-ctx.Done():
			return nil, nil
		case processErr := <-fatal:
			return nil, processErr
		case <-time.After(backoff.Next()):
		}
	}
}

func (runtime *childRuntime) readLoop(ctx context.Context, control *controlConnection) error {
	for {
		var message Message
		if err := control.Read(&message); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("read Factory control message: %w", err)
		}
		switch message.Type {
		case "http-request":
			runtime.startHTTPRequest(ctx, message)
		case "websocket-open":
			if message.Channel == "language" {
				if message.AppAuthorization != "" {
					runtime.sendError(message.StreamID, "invalid App authorization")
				} else {
					runtime.languages.Attach(message)
				}
			} else {
				go runtime.openWebSocket(ctx, message)
			}
		case "websocket-message":
			runtime.writeWebSocket(message)
		case "stream-close":
			runtime.closeStream(message.StreamID)
		case "operation-request":
			go runtime.handleOperation(message)
		default:
			if err := runtime.send(Message{Type: "stream-error", StreamID: message.StreamID, Error: "unsupported message"}); err != nil {
				return err
			}
		}
	}
}

func (runtime *childRuntime) setControl(control *controlConnection) {
	runtime.controlLock.Lock()
	runtime.control = control
	runtime.controlLock.Unlock()
}

func (runtime *childRuntime) send(message Message) error {
	if (message.Type == "terminal-state" || message.Type == "command-state") && runtime.commands != nil {
		count := runtime.commands.ActiveCount()
		message.CommandCount = &count
	}
	runtime.controlLock.RLock()
	control := runtime.control
	runtime.controlLock.RUnlock()
	if control == nil {
		return errors.New("Factory control connection is unavailable")
	}
	return control.Write(message)
}

func (runtime *childRuntime) sendError(streamID string, message string) {
	_ = runtime.send(Message{Type: "stream-error", StreamID: streamID, Error: message})
}
