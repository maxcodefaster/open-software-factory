package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

const (
	maxTerminalSessions   = 8
	maxTerminalScrollback = 64 << 10
)

var terminalIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

type TerminalControl struct {
	Type    string `json:"type"`
	Columns uint16 `json:"columns"`
	Rows    uint16 `json:"rows"`
}

type CommandInput struct {
	ID      string `json:"id"`
	Input   []byte `json:"input,omitempty"`
	Columns uint16 `json:"columns,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`
}

type terminalSession struct {
	id         string
	file       *os.File
	command    *exec.Cmd
	attachment string
	output     []byte
	executable os.FileInfo
	cpu        uint64
	digest     string
	startedAt  string
	outputSize uint64
	cancelled  bool
}

type Manager struct {
	ctx        context.Context
	assignment protocol.Assignment
	send       func(protocol.Message) error
	mutex      sync.Mutex
	sessions   map[string]*terminalSession
	streams    map[string]string
	revision   uint64
	busy       int
	completed  map[string]protocol.CommandView
	closedIDs  []string
}

func (manager *Manager) Observation() protocol.Message {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	count, revision := len(manager.sessions), manager.revision
	busy := 0
	for _, session := range manager.sessions {
		if terminalBusy(session) {
			busy++
		}
	}
	if manager.busy != busy {
		manager.busy = busy
		manager.revision++
		revision = manager.revision
	}
	return protocol.Message{Type: "terminal-state", TerminalCount: &count, TerminalBusy: &busy, TerminalRevision: &revision}
}

func (manager *Manager) Watch() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-manager.ctx.Done():
			return
		case <-ticker.C:
			manager.Publish()
		}
	}
}

func (manager *Manager) Publish() {
	_ = manager.send(manager.Observation())
}

func NewManager(ctx context.Context, assignment protocol.Assignment, send func(protocol.Message) error) *Manager {
	return &Manager{
		ctx:        ctx,
		assignment: assignment,
		send:       send,
		sessions:   make(map[string]*terminalSession),
		streams:    make(map[string]string),
		completed:  make(map[string]protocol.CommandView),
	}
}

func (manager *Manager) Attach(message protocol.Message) {
	id := strings.TrimPrefix(message.Path, "/")
	if message.StreamID == "" || !terminalIDPattern.MatchString(id) {
		manager.send(protocol.Message{Type: "stream-error", StreamID: message.StreamID, Error: "invalid terminal session"})
		return
	}
	manager.mutex.Lock()
	session := manager.sessions[id]
	createdSession := false
	if session == nil {
		if len(manager.sessions) >= maxTerminalSessions {
			manager.mutex.Unlock()
			manager.send(protocol.Message{Type: "stream-error", StreamID: message.StreamID, Error: "terminal session limit reached"})
			return
		}
		created, err := manager.start(id)
		if err != nil {
			manager.mutex.Unlock()
			manager.send(protocol.Message{Type: "stream-error", StreamID: message.StreamID, Error: "start terminal"})
			return
		}
		session = created
		manager.sessions[id] = session
		manager.revision++
		createdSession = true
		go manager.read(session)
	}
	if session.attachment != "" && session.attachment != message.StreamID {
		delete(manager.streams, session.attachment)
		_ = manager.send(protocol.Message{Type: "stream-close", StreamID: session.attachment})
	}
	session.attachment = message.StreamID
	manager.streams[message.StreamID] = id
	replay := append([]byte(nil), session.output...)
	manager.mutex.Unlock()
	if createdSession {
		manager.Publish()
	}
	if err := manager.send(protocol.Message{Type: "websocket-ready", StreamID: message.StreamID}); err != nil {
		manager.Detach(message.StreamID)
		return
	}
	if len(replay) > 0 {
		_ = manager.send(protocol.Message{
			Type:        "websocket-message",
			StreamID:    message.StreamID,
			MessageType: websocket.BinaryMessage,
			Data:        base64.StdEncoding.EncodeToString(replay),
		})
	}
}

func (manager *Manager) start(id string) (*terminalSession, error) {
	shell := os.Getenv("SHELL")
	if !strings.HasPrefix(shell, "/") {
		shell = "/bin/sh"
	}
	command := exec.CommandContext(manager.ctx, shell, "-l")
	command.Dir = manager.assignment.WorkspaceFolder
	command.Env = append(procutil.AssignedEnvironment(os.Environ(), manager.assignment.RuntimeEnvironment), "TERM=xterm-256color")
	var file *os.File
	err := manager.assignment.StartNativeWriter(func() error {
		var err error
		file, err = pty.StartWithSize(command, &pty.Winsize{Rows: 30, Cols: 100})
		return err
	})
	if err != nil {
		return nil, err
	}
	executable, _ := os.Stat(command.Path)
	return &terminalSession{id: id, file: file, command: command, executable: executable, startedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func (manager *Manager) read(session *terminalSession) {
	buffer := make([]byte, 32<<10)
	for {
		count, err := session.file.Read(buffer)
		if count > 0 {
			content := append([]byte(nil), buffer[:count]...)
			manager.mutex.Lock()
			session.outputSize += uint64(count)
			session.output = append(session.output, content...)
			if len(session.output) > maxTerminalScrollback {
				session.output = append([]byte(nil), session.output[len(session.output)-maxTerminalScrollback:]...)
			}
			streamID := session.attachment
			manager.mutex.Unlock()
			if streamID != "" {
				_ = manager.send(protocol.Message{
					Type:        "websocket-message",
					StreamID:    streamID,
					MessageType: websocket.BinaryMessage,
					Data:        base64.StdEncoding.EncodeToString(content),
				})
			}
		}
		if err != nil {
			break
		}
	}
	_ = session.command.Wait()
	manager.mutex.Lock()
	var final *protocol.CommandView
	if session.digest != "" {
		view := manager.commandSnapshot(session, session.outputSize-uint64(len(session.output)))
		view.Stdout = append([]byte(nil), session.output...)
		view.StdoutNext = session.outputSize
		view.State = "exited"
		if session.cancelled || manager.ctx.Err() != nil {
			view.State = "cancelled"
		}
		view.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		code := session.command.ProcessState.ExitCode()
		view.ExitCode = &code
		manager.completed[session.id] = view
		manager.closedIDs = append(manager.closedIDs, session.id)
		if len(manager.closedIDs) > 128 {
			old := manager.completed[manager.closedIDs[0]]
			old.Stdout = nil
			old.StdoutFrom = old.StdoutNext
			manager.completed[old.ID] = old
			manager.closedIDs = manager.closedIDs[1:]
		}
		final = &view
	}
	current := manager.sessions[session.id]
	if current == session {
		delete(manager.sessions, session.id)
		manager.revision++
		if session.attachment != "" {
			delete(manager.streams, session.attachment)
		}
	}
	streamID := session.attachment
	manager.mutex.Unlock()
	if final != nil {
		final.Stdout = nil
		data, _ := json.Marshal(final)
		_ = manager.send(protocol.Message{Type: "command-state", Data: string(data)})
	}
	if current == session {
		manager.Publish()
	}
	if streamID != "" {
		_ = manager.send(protocol.Message{Type: "stream-close", StreamID: streamID})
	}
}

// MCP observes the same retained PTY without taking over its browser attachment.
func (manager *Manager) OpenCommand(input protocol.CommandRequest) (protocol.CommandView, error) {
	if !procutil.CommandIDPattern.MatchString(input.ID) || len(input.Digest) != 64 {
		return protocol.CommandView{}, errors.New("invalid terminal command identity")
	}
	manager.mutex.Lock()
	if previous, exists := manager.completed[input.ID]; exists {
		manager.mutex.Unlock()
		if previous.Digest != input.Digest {
			return protocol.CommandView{}, errors.New("terminal identity already belongs to another operation")
		}
		return terminalCompletedPage(previous, 0), nil
	}
	session := manager.sessions[input.ID]
	created := false
	if session == nil {
		if len(manager.sessions) >= maxTerminalSessions || manager.ctx.Err() != nil {
			manager.mutex.Unlock()
			return protocol.CommandView{}, errors.New("terminal execution is unavailable")
		}
		var err error
		session, err = manager.start(input.ID)
		if err != nil {
			manager.mutex.Unlock()
			return protocol.CommandView{}, err
		}
		session.digest = input.Digest
		manager.sessions[input.ID] = session
		manager.revision++
		created = true
	} else if session.digest != input.Digest {
		manager.mutex.Unlock()
		return protocol.CommandView{}, errors.New("terminal identity already belongs to another operation")
	}
	view := manager.commandSnapshot(session, 0)
	manager.mutex.Unlock()
	if created {
		go manager.read(session)
		manager.Publish()
	}
	return view, nil
}

func (manager *Manager) commandSnapshot(session *terminalSession, cursor uint64) protocol.CommandView {
	start := session.outputSize - uint64(len(session.output))
	lost := cursor < start
	if cursor < start {
		cursor = start
	}
	if cursor > session.outputSize {
		cursor = session.outputSize
	}
	end := min(session.outputSize, cursor+16384)
	return protocol.CommandView{ID: session.id, Digest: session.digest, State: "running", PID: session.command.Process.Pid,
		StartedAt: session.startedAt, Stdout: append([]byte(nil), session.output[cursor-start:end-start]...),
		StdoutFrom: cursor, StdoutNext: end, OutputLost: lost}
}

func (manager *Manager) ReadCommand(input protocol.CommandRead) (protocol.CommandView, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	session := manager.sessions[input.ID]
	if session == nil {
		if previous, exists := manager.completed[input.ID]; exists {
			return terminalCompletedPage(previous, input.Stdout), nil
		}
	}
	if session == nil || session.digest == "" {
		return protocol.CommandView{}, errors.New("terminal outcome is unavailable in this runtime")
	}
	return manager.commandSnapshot(session, input.Stdout), nil
}

func terminalCompletedPage(view protocol.CommandView, cursor uint64) protocol.CommandView {
	start := view.StdoutFrom
	view.OutputLost = cursor < start
	if cursor < start {
		cursor = start
	}
	if cursor > view.StdoutNext {
		cursor = view.StdoutNext
	}
	end := min(view.StdoutNext, cursor+16384)
	view.Stdout = append([]byte(nil), view.Stdout[cursor-start:end-start]...)
	view.StdoutFrom, view.StdoutNext = cursor, end
	return view
}

func (manager *Manager) InputCommand(input CommandInput, resize bool) (protocol.CommandView, error) {
	if len(input.Input) > 8192 {
		return protocol.CommandView{}, errors.New("terminal input is too large")
	}
	manager.mutex.Lock()
	session := manager.sessions[input.ID]
	manager.mutex.Unlock()
	if session == nil || session.digest == "" {
		return protocol.CommandView{}, errors.New("terminal is unavailable")
	}
	var err error
	if resize {
		if input.Columns < 2 || input.Columns > 500 || input.Rows < 1 || input.Rows > 500 {
			return protocol.CommandView{}, errors.New("invalid terminal size")
		}
		err = pty.Setsize(session.file, &pty.Winsize{Cols: input.Columns, Rows: input.Rows})
	} else {
		_, err = session.file.Write(input.Input)
	}
	if err != nil {
		return protocol.CommandView{}, err
	}
	return manager.ReadCommand(protocol.CommandRead{ID: input.ID})
}

func (manager *Manager) CloseCommand(input protocol.CommandRead) (protocol.CommandView, error) {
	view, err := manager.ReadCommand(input)
	if err != nil {
		return protocol.CommandView{}, err
	}
	if view.State != "running" {
		return view, nil
	}
	if err := manager.Close(input.ID); err != nil {
		return protocol.CommandView{}, err
	}
	view.State = "cancelled"
	view.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return view, nil
}

func (manager *Manager) Write(message protocol.Message) (bool, error) {
	data, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(data) > protocol.MaxMessageBytes {
		return true, errors.New("invalid terminal message")
	}
	manager.mutex.Lock()
	id, attached := manager.streams[message.StreamID]
	session := manager.sessions[id]
	manager.mutex.Unlock()
	if !attached {
		return false, nil
	}
	if session == nil {
		return true, errors.New("terminal session is not attached")
	}
	if message.MessageType == websocket.TextMessage {
		var control TerminalControl
		if json.Unmarshal(data, &control) != nil || control.Type != "resize" || control.Columns < 2 || control.Rows < 1 {
			return true, errors.New("invalid terminal control")
		}
		return true, pty.Setsize(session.file, &pty.Winsize{Cols: control.Columns, Rows: control.Rows})
	}
	if message.MessageType != websocket.BinaryMessage {
		return true, errors.New("invalid terminal message type")
	}
	_, err = session.file.Write(data)
	return true, err
}

func (manager *Manager) Detach(streamID string) bool {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	id, exists := manager.streams[streamID]
	if !exists {
		return false
	}
	delete(manager.streams, streamID)
	if session := manager.sessions[id]; session != nil && session.attachment == streamID {
		session.attachment = ""
	}
	return true
}

func (manager *Manager) DetachAll() {
	manager.mutex.Lock()
	manager.streams = make(map[string]string)
	for _, session := range manager.sessions {
		session.attachment = ""
	}
	manager.mutex.Unlock()
}

func (manager *Manager) Close(id string) error {
	if !terminalIDPattern.MatchString(id) {
		return errors.New("invalid terminal session")
	}
	manager.mutex.Lock()
	session := manager.sessions[id]
	if session == nil {
		manager.mutex.Unlock()
		return nil
	}
	delete(manager.sessions, id)
	session.cancelled = true
	manager.revision++
	if session.attachment != "" {
		delete(manager.streams, session.attachment)
	}
	streamID := session.attachment
	manager.mutex.Unlock()
	manager.Publish()
	_ = session.file.Close()
	if session.command.Process != nil {
		_ = session.command.Process.Kill()
	}
	if streamID != "" {
		_ = manager.send(protocol.Message{Type: "stream-close", StreamID: streamID})
	}
	return nil
}

func (manager *Manager) CloseAll() {
	manager.mutex.Lock()
	ids := make([]string, 0, len(manager.sessions))
	for id := range manager.sessions {
		ids = append(ids, id)
	}
	manager.mutex.Unlock()
	for _, id := range ids {
		_ = manager.Close(id)
	}
}

func (manager *Manager) SessionCount() int {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	return len(manager.sessions)
}

func (manager *Manager) HasSession(id string) bool {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	_, exists := manager.sessions[id]
	return exists
}
