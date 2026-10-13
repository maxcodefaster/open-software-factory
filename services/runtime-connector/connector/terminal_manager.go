package connector

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

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const (
	maxTerminalSessions   = 8
	maxTerminalScrollback = 64 << 10
)

var terminalIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

type terminalSession struct {
	id         string
	file       *os.File
	command    *exec.Cmd
	attachment string
	output     []byte
}

type terminalManager struct {
	ctx        context.Context
	assignment Assignment
	send       func(Message) error
	mutex      sync.Mutex
	sessions   map[string]*terminalSession
	streams    map[string]string
	revision   uint64
}

func (manager *terminalManager) observation() Message {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	count, revision := len(manager.sessions), manager.revision
	return Message{Type: "terminal-state", TerminalCount: &count, TerminalRevision: &revision}
}

func (manager *terminalManager) publish() {
	_ = manager.send(manager.observation())
}

func newTerminalManager(ctx context.Context, assignment Assignment, send func(Message) error) *terminalManager {
	return &terminalManager{
		ctx:        ctx,
		assignment: assignment,
		send:       send,
		sessions:   make(map[string]*terminalSession),
		streams:    make(map[string]string),
	}
}

func (manager *terminalManager) attach(message Message) {
	id := strings.TrimPrefix(message.Path, "/")
	if message.StreamID == "" || !terminalIDPattern.MatchString(id) {
		manager.send(Message{Type: "stream-error", StreamID: message.StreamID, Error: "invalid terminal session"})
		return
	}
	manager.mutex.Lock()
	session := manager.sessions[id]
	createdSession := false
	if session == nil {
		if len(manager.sessions) >= maxTerminalSessions {
			manager.mutex.Unlock()
			manager.send(Message{Type: "stream-error", StreamID: message.StreamID, Error: "terminal session limit reached"})
			return
		}
		created, err := manager.start(id)
		if err != nil {
			manager.mutex.Unlock()
			manager.send(Message{Type: "stream-error", StreamID: message.StreamID, Error: "start terminal"})
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
		_ = manager.send(Message{Type: "stream-close", StreamID: session.attachment})
	}
	session.attachment = message.StreamID
	manager.streams[message.StreamID] = id
	replay := append([]byte(nil), session.output...)
	manager.mutex.Unlock()
	if createdSession {
		manager.publish()
	}
	if err := manager.send(Message{Type: "websocket-ready", StreamID: message.StreamID}); err != nil {
		manager.detach(message.StreamID)
		return
	}
	if len(replay) > 0 {
		_ = manager.send(Message{
			Type:        "websocket-message",
			StreamID:    message.StreamID,
			MessageType: websocket.BinaryMessage,
			Data:        base64.StdEncoding.EncodeToString(replay),
		})
	}
}

func (manager *terminalManager) start(id string) (*terminalSession, error) {
	shell := os.Getenv("SHELL")
	if !strings.HasPrefix(shell, "/") {
		shell = "/bin/sh"
	}
	command := exec.CommandContext(manager.ctx, shell, "-l")
	command.Dir = manager.assignment.WorkspaceFolder
	command.Env = append(assignedEnvironment(os.Environ(), manager.assignment.RuntimeEnvironment), "TERM=xterm-256color")
	file, err := pty.StartWithSize(command, &pty.Winsize{Rows: 30, Cols: 100})
	if err != nil {
		return nil, err
	}
	return &terminalSession{id: id, file: file, command: command}, nil
}

func (manager *terminalManager) read(session *terminalSession) {
	buffer := make([]byte, 32<<10)
	for {
		count, err := session.file.Read(buffer)
		if count > 0 {
			content := append([]byte(nil), buffer[:count]...)
			manager.mutex.Lock()
			session.output = append(session.output, content...)
			if len(session.output) > maxTerminalScrollback {
				session.output = append([]byte(nil), session.output[len(session.output)-maxTerminalScrollback:]...)
			}
			streamID := session.attachment
			manager.mutex.Unlock()
			if streamID != "" {
				_ = manager.send(Message{
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
	if current == session {
		manager.publish()
	}
	if streamID != "" {
		_ = manager.send(Message{Type: "stream-close", StreamID: streamID})
	}
}

func (manager *terminalManager) write(message Message) (bool, error) {
	data, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(data) > maxMessageBytes {
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
		var control terminalControl
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

func (manager *terminalManager) detach(streamID string) bool {
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

func (manager *terminalManager) detachAll() {
	manager.mutex.Lock()
	manager.streams = make(map[string]string)
	for _, session := range manager.sessions {
		session.attachment = ""
	}
	manager.mutex.Unlock()
}

func (manager *terminalManager) close(id string) error {
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
	manager.revision++
	if session.attachment != "" {
		delete(manager.streams, session.attachment)
	}
	streamID := session.attachment
	manager.mutex.Unlock()
	manager.publish()
	_ = session.file.Close()
	if session.command.Process != nil {
		_ = session.command.Process.Kill()
	}
	if streamID != "" {
		_ = manager.send(Message{Type: "stream-close", StreamID: streamID})
	}
	return nil
}

func (manager *terminalManager) closeAll() {
	manager.mutex.Lock()
	ids := make([]string, 0, len(manager.sessions))
	for id := range manager.sessions {
		ids = append(ids, id)
	}
	manager.mutex.Unlock()
	for _, id := range ids {
		_ = manager.close(id)
	}
}
