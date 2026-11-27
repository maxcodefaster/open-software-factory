package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

const nativeBrowserDirectory = "/factory/browser"

// One local tool process in one dedicated native Browser Actor. The Actor's
// creation/deletion, image, placement and resource limits belong to Factory's
// persisted native binding and Substrate, never this process owner.
type nativeBrowserWorker struct {
	assignment protocol.Assignment
	scope      browserRuntimeRequest
	runtime    *browserRuntime
	mu         sync.Mutex
	observe    func(context.Context, browserRuntimeRequest, string) (*browserInspectionContext, error)
	httpRead   func(context.Context, string, uint64) (json.RawMessage, error)
	startProxy func(context.Context) (func(), error)
	proxyStop  func()
	command    browserRecordingCommand
}

func newNativeBrowserWorker(ctx context.Context, assignment protocol.Assignment, scope browserRuntimeRequest) *nativeBrowserWorker {
	live, cancel := context.WithCancel(ctx)
	return &nativeBrowserWorker{
		assignment: assignment, scope: scope, command: runNativeBrowserCommand,
		runtime: &browserRuntime{scope: scope, directory: nativeBrowserDirectory, ctx: live, cancel: cancel},
	}
}

func runNativeBrowserCommand(ctx context.Context, executable string, arguments ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, executable, arguments...)
	if err := prepareNativeBrowserProcess(command); err != nil {
		return nil, err
	}
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", "CI=1"}
	command.Dir = "/tmp"
	var output browserDockerOutput
	command.Stdout, command.Stderr = &output, io.Discard
	if command.Run() != nil {
		return nil, errors.New("native Browser file operation was not confirmed")
	}
	return output.Bytes(), nil
}

func (worker *nativeBrowserWorker) handle(ctx context.Context, message protocol.Message) protocol.Message {
	response := protocol.Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	scope, err := decodeBrowserRuntimeRequest(message, worker.assignment)
	if err == nil && !sameBrowserScope(worker.scope, scope) {
		err = errors.New("browser operation does not match its admitted execution scope")
	}
	if err == nil && (ctx.Err() != nil || worker.runtime.ctx.Err() != nil) && message.Action != "browser-close" {
		err = errors.New("browser session is no longer active")
	}
	if err == nil {
		switch message.Action {
		case "browser-call":
			response.Data, err = worker.call(scope)
		case "browser-renew":
			// Renewal before the first tool call must not create execution.
			worker.runtime.authority.Lock()
			started := !worker.runtime.expiresAt.IsZero()
			worker.runtime.authority.Unlock()
			if started {
				err = worker.runtime.renewAuthority(scope, true)
			}
		case "browser-close":
			err = worker.close()
		case "browser-recording-start", "browser-recording-finish", "browser-recording-chunk":
			runtime := worker.runtime
			if message.Action == "browser-recording-finish" {
				// The one admitted finalizer checks the process/page under
				// runtime.mu. Status polls, including concurrent first polls,
				// must not wait on that lock while the encoder drains.
				response.Data, err = recordBrowser(runtime, scope, message.Action, worker.command)
				break
			}
			runtime.mu.Lock()
			started := runtime.command != nil
			runtime.mu.Unlock()
			if !started {
				err = errors.New("recording browser is unavailable")
			} else {
				response.Data, err = recordBrowser(worker.runtime, scope, message.Action, worker.command)
			}
		default:
			err = errors.New("unsupported browser operation")
		}
	}
	if err != nil {
		response.Error = err.Error()
	}
	return response
}

func (worker *nativeBrowserWorker) start() error {
	runtime := worker.runtime
	if worker.startProxy == nil || worker.observe == nil || worker.httpRead == nil {
		return errors.New("native Browser relay is unavailable")
	}
	for _, path := range []string{runtime.directory, filepath.Join(runtime.directory, "config")} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&0022 != 0 {
			return errors.New("native Browser control directory is unavailable")
		}
	}
	config, _ := json.Marshal(worker.assignment.Channels)
	if err := writeBrowserConfig(runtime.directory, "apps.json", config); err != nil {
		return errors.New("browser App assignment could not be written")
	}
	content, _ := json.Marshal(worker.scope)
	file, err := os.OpenFile(filepath.Join(runtime.directory, "scope.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0400)
	if err != nil {
		return errors.New("browser session requires owned cleanup after parent restart; do not replay a UI mutation")
	}
	_, written := file.Write(content)
	if errors.Join(written, file.Close()) != nil {
		return errors.New("browser execution scope could not be recorded")
	}
	cleanup, err := worker.startProxy(runtime.ctx)
	if err != nil {
		return err
	}
	worker.proxyStop = cleanup
	command := exec.Command("/usr/local/bin/factory-browser-worker")
	if err := prepareNativeBrowserProcess(command); err != nil {
		return err
	}
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", "CI=1"}
	command.Dir, command.Stderr = "/tmp", io.Discard
	runtime.input, err = command.StdinPipe()
	if err != nil {
		return errors.New("browser tool input unavailable")
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return errors.New("browser tool output unavailable")
	}
	if command.Start() != nil {
		return errors.New("browser tool process failed to start")
	}
	runtime.command, runtime.wait = command, make(chan error, 1)
	go func() { runtime.wait <- command.Wait() }()
	runtime.responses = make(chan browserMCPReply, 4)
	go func() {
		defer close(runtime.responses)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 65536), 3<<20)
		for scanner.Scan() {
			var reply browserMCPReply
			if json.Unmarshal(scanner.Bytes(), &reply) != nil || reply.ID == 0 {
				continue
			}
			select {
			case runtime.responses <- reply:
			case <-runtime.ctx.Done():
				return
			}
		}
	}()
	bounded, end := context.WithTimeout(runtime.ctx, procutil.BrowserOpenTimeout)
	defer end()
	initialized, err := runtime.rpc(bounded, "initialize", map[string]any{
		"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "factory-native-browser", "version": "1"},
	})
	if err != nil {
		return err
	}
	var identity struct {
		ServerInfo struct{ Version string } `json:"serverInfo"`
	}
	if json.Unmarshal(initialized, &identity) != nil || identity.ServerInfo.Version != browserMCPVersion {
		return errors.New("browser MCP did not report the pinned upstream version")
	}
	if json.NewEncoder(runtime.input).Encode(map[string]string{"jsonrpc": "2.0", "method": "notifications/initialized"}) != nil {
		return errors.New("browser MCP initialization was not confirmed")
	}
	go func() {
		lease, cancel, err := browserAuthorityContext(runtime.ctx, filepath.Join(runtime.directory, "config", "authority.json"))
		if err == nil {
			<-lease.Done()
			cancel()
		}
		_ = worker.close()
	}()
	return nil
}

func (worker *nativeBrowserWorker) call(scope browserRuntimeRequest) (string, error) {
	runtime := worker.runtime
	runtime.mu.Lock()
	unopened := runtime.command == nil && scope.Call.Name != "browser_open"
	runtime.mu.Unlock()
	if unopened {
		return "", errors.New("open a declared App before inspecting it")
	}
	if err := runtime.renewAuthority(scope, false); err != nil {
		return "", err
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed || runtime.ctx.Err() != nil {
		return "", errors.New("browser session is no longer active")
	}
	if runtime.command == nil {
		if scope.Call.Name != "browser_open" {
			return "", errors.New("open a declared App before inspecting it")
		}
		if _, err := resolveBrowserTool(worker.assignment.Channels, 0, scope.Call); err != nil {
			return "", err
		}
		if err := worker.start(); err != nil {
			runtime.cancel()
			go worker.close()
			return "", err
		}
	}
	timeout := procutil.BrowserCallTimeout
	if scope.Call.Name == "browser_open" {
		timeout = procutil.BrowserOpenTimeout
	}
	bounded, end := context.WithTimeout(runtime.ctx, timeout)
	defer end()
	if runtime.pendingApp != "" {
		if scope.Call.Name != "browser_snapshot" {
			return "", errors.New("inspect a fresh browser_snapshot before another browser action")
		}
		for {
			pages, err := runtime.rpc(bounded, "tools/call", map[string]any{"name": "list_pages", "arguments": map[string]any{}})
			if err != nil {
				runtime.cancel()
				go worker.close()
				return "", err
			}
			err = runtime.selectDeclaredPage(pages, runtime.pendingApp)
			if err == nil {
				break
			}
			if !errors.Is(err, errBrowserPagePending) {
				return "", err
			}
			select {
			case <-bounded.Done():
				return "", errBrowserPagePending
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	dispatch, err := resolveBrowserTool(worker.assignment.Channels, runtime.pageID, scope.Call)
	if err != nil {
		return "", err
	}
	var position *int64
	if scope.Call.Name != "browser_http_observations" && !runtime.recordingStarted.IsZero() && runtime.recordingEnded.IsZero() {
		position = readBrowserRecordingPosition(bounded, worker.command, false)
	}
	var raw json.RawMessage
	if dispatch.Name == "factory_http_observations" {
		raw, err = worker.httpRead(bounded, runtime.app, dispatch.After)
		if err != nil {
			return `{"isError":true,"content":[{"type":"text","text":"Browser HTTP observations unavailable. No App request ran; missing metadata remains unknown."}]}`, nil
		}
	} else {
		raw, err = runtime.rpc(bounded, "tools/call", map[string]any{"name": dispatch.Name, "arguments": dispatch.Arguments})
	}
	if err != nil {
		runtime.cancel()
		go worker.close()
		return "", err
	}
	result, err := boundBrowserResult(scope.Call.Name, raw)
	if err != nil {
		runtime.cancel()
		go worker.close()
		return "", err
	}
	if result.IsError {
		if scope.Call.Name == "browser_open" {
			runtime.pendingApp = dispatch.App
		}
		text := result.Content[:0]
		for _, item := range result.Content {
			if item.Type == "text" {
				text = append(text, item)
			}
		}
		result.Content = text
		encoded, err := json.Marshal(result)
		return string(encoded), err
	}
	if scope.Call.Name == "browser_open" {
		if err := runtime.selectDeclaredPage(raw, dispatch.App); err != nil {
			return "", err
		}
	}
	if page := browserObservedPage(raw, runtime.app, runtime.pageID); page != "" {
		runtime.pagePath = page
	}
	result.StructuredContent, err = worker.observe(bounded, scope, runtime.app)
	if err != nil {
		runtime.cancel()
		go worker.close()
		return "", err
	}
	context := result.StructuredContent
	if context == nil || context.SessionID != scope.SessionID || context.TurnID != scope.TurnID ||
		context.AttemptID != worker.assignment.RuntimeAttemptID || context.Generation != worker.assignment.Generation ||
		context.App != runtime.app || !browserCommitPattern.MatchString(context.HeadCommit) {
		runtime.cancel()
		go worker.close()
		return "", errors.New("Browser observation does not match this execution scope")
	}
	context.RecordingTimeMS, context.Page = position, runtime.pagePath
	encoded, err := json.Marshal(result)
	return string(encoded), err
}

func (worker *nativeBrowserWorker) close() error {
	runtime := worker.runtime
	runtime.cancel()
	worker.mu.Lock()
	defer worker.mu.Unlock()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed {
		return nil
	}
	if runtime.input != nil {
		runtime.input.Close()
	}
	if runtime.command != nil && runtime.command.Process != nil {
		procutil.TerminateAssignedProcess(runtime.command)
	}
	if worker.proxyStop != nil {
		worker.proxyStop()
		worker.proxyStop = nil
	}
	if runtime.wait != nil {
		select {
		case <-runtime.wait:
		case <-time.After(8 * time.Second):
			procutil.StopAssignedProcess(runtime.command)
			select {
			case <-runtime.wait:
			case <-time.After(2 * time.Second):
				return errors.New("browser process cleanup was not confirmed")
			}
		}
		runtime.wait = nil
	}
	runtime.closed = true
	return nil
}
