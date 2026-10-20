package connector

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/gorilla/websocket"
)

const languageToolsRoot = "/opt/factory/language-tools"

type languageSession struct {
	command     *exec.Cmd
	input       io.WriteCloser
	scope       languageURIs
	language    string
	writes      chan any
	done        chan struct{}
	stopOnce    sync.Once
	documentsMu sync.Mutex
	documents   map[string]string
	attemptID   string
	initialized bool
}

type languageManager struct {
	ctx        context.Context
	assignment Assignment
	send       func(Message) error
	mutex      sync.Mutex
	sessions   map[string]*languageSession
	readers    sync.WaitGroup
	stopping   bool
}

func newLanguageManager(ctx context.Context, assignment Assignment, send func(Message) error) *languageManager {
	return &languageManager{ctx: ctx, assignment: assignment, send: send, sessions: make(map[string]*languageSession)}
}

func (manager *languageManager) attach(message Message) {
	parts := strings.Split(strings.TrimPrefix(message.Path, "/"), "/")
	channel, declared := manager.assignment.channel("ide")
	interactive := declared && channel.Kind == "ide"
	if !interactive || message.StreamID == "" || len(parts) != 2 || (parts[0] != "typescript" && parts[0] != "python") || !identityPattern.MatchString(parts[1]) {
		manager.fail(message.StreamID, "Language tools are unavailable for this Workspace.")
		return
	}
	manager.mutex.Lock()
	if manager.stopping || len(manager.sessions) >= 4 || manager.sessions[message.StreamID] != nil {
		manager.mutex.Unlock()
		manager.fail(message.StreamID, "Close unused language tools before opening another connection.")
		return
	}
	script := "typescript-language-server/lib/cli.mjs"
	if parts[0] == "python" {
		script = "pyright/langserver.index.js"
	}
	command := exec.CommandContext(manager.ctx, filepath.Join(languageToolsRoot, "runtime/node"), filepath.Join(languageToolsRoot, "node_modules", script), "--stdio")
	command.Dir = manager.assignment.WorkspaceFolder
	command.Env = languageEnvironment(assignedEnvironment(os.Environ(), manager.assignment.RuntimeEnvironment))
	command.Stderr = io.Discard
	PrepareAssignedProcess(command)
	input, err := command.StdinPipe()
	var output io.ReadCloser
	if err == nil {
		output, err = command.StdoutPipe()
	}
	if err == nil {
		err = command.Start()
	}
	if err != nil {
		manager.mutex.Unlock()
		if input != nil {
			input.Close()
		}
		if output != nil {
			output.Close()
		}
		manager.fail(message.StreamID, "Language tools are not installed in this runtime. Restart compute to use the published preset.")
		return
	}
	session := &languageSession{command: command, input: input, scope: languageURIs{parts[1], manager.assignment.WorkspaceFolder}, language: parts[0], documents: make(map[string]string), attemptID: manager.assignment.RuntimeAttemptID, writes: make(chan any, 16), done: make(chan struct{})}
	manager.sessions[message.StreamID] = session
	manager.readers.Add(2)
	manager.mutex.Unlock()
	if manager.send(Message{Type: "websocket-ready", StreamID: message.StreamID}) != nil {
		manager.close(message.StreamID)
	}
	go func() {
		defer manager.readers.Done()
		manager.read(message.StreamID, session, output)
	}()
	go func() {
		defer manager.readers.Done()
		manager.writeLoop(message.StreamID, session)
	}()
}

func languageEnvironment(environment []string) []string {
	result := make([]string, 0, len(environment))
	libraryPath := filepath.Join(languageToolsRoot, "runtime/lib")
	for _, entry := range environment {
		name, value, _ := strings.Cut(entry, "=")
		if name == "NODE_OPTIONS" || name == "NODE_PATH" || name == "BUN_OPTIONS" || strings.HasPrefix(name, "BUN_INSPECT") || name == "LD_PRELOAD" {
			continue
		}
		if name == "LD_LIBRARY_PATH" {
			if value != "" {
				libraryPath += ":" + value
			}
			continue
		}
		result = append(result, entry)
	}
	return append(result, "LD_LIBRARY_PATH="+libraryPath)
}

func (session *languageSession) write(value any) error {
	select {
	case <-session.done:
		return errors.New("language connection is closed")
	default:
	}
	select {
	case <-session.done:
		return errors.New("language connection is closed")
	case session.writes <- value:
		return nil
	default:
		return errors.New("language input queue is full")
	}
}

func (manager *languageManager) writeLoop(streamID string, session *languageSession) {
	for {
		select {
		case <-session.done:
			return
		case value := <-session.writes:
			select {
			case <-session.done:
				return
			default:
			}
			if err := writeLanguageMessage(session.input, value); err != nil {
				select {
				case <-session.done:
					return
				default:
				}
				manager.fail(streamID, "Language connection is unavailable.")
				manager.close(streamID)
				return
			}
		}
	}
}

func (manager *languageManager) write(message Message) (bool, error) {
	manager.mutex.Lock()
	session := manager.sessions[message.StreamID]
	manager.mutex.Unlock()
	if session == nil {
		return false, nil
	}
	body, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(body) > maxLanguageBytes || message.MessageType != websocket.TextMessage {
		return true, errors.New("invalid language message")
	}
	var value map[string]any
	if json.Unmarshal(body, &value) != nil || value["jsonrpc"] != "2.0" {
		return true, errors.New("invalid language message")
	}
	method, _ := value["method"].(string)
	if method == "factory/readDocument" {
		return true, manager.readDocument(message.StreamID, session, value)
	}
	if !allowedLanguageMethod(method) {
		return true, errors.New("language operation is not supported")
	}
	if method == "initialize" {
		if session.initialized {
			return true, errors.New("language connection is already initialized")
		}
		session.initialized = true
		// Factory, not browser input or a repository editor config, owns process
		// arguments, roots, server plugins and executable discovery.
		params, ok := value["params"].(map[string]any)
		if !ok {
			return true, errors.New("language initialization is invalid")
		}
		params["processId"] = nil
		params["rootPath"] = session.scope.root
		params["rootUri"] = (&url.URL{Scheme: "factory-workspace", Host: session.scope.workspaceID, Path: "/"}).String()
		params["workspaceFolders"] = []any{map[string]any{"uri": params["rootUri"], "name": "Workspace"}}
		params["initializationOptions"] = map[string]any{"disableAutomaticTypingAcquisition": true, "tsserver": map[string]any{"useSyntaxServer": "never"}}
	}
	mapped, err := mapLanguageURIs(value, session.scope.toRuntime, false)
	if err != nil {
		return true, err
	}
	return true, session.write(mapped)
}

func (manager *languageManager) read(streamID string, session *languageSession, output io.ReadCloser) {
	defer output.Close()
	defer session.command.Wait()
	defer manager.close(streamID)
	reader := bufio.NewReaderSize(output, 8<<10)
	for {
		body, err := readLanguageMessage(reader)
		if err != nil {
			break
		}
		var value map[string]any
		if json.Unmarshal(body, &value) != nil {
			break
		}
		if method, ok := value["method"].(string); ok {
			if id, request := value["id"]; request {
				// No applyEdit, executeCommand, plugin registration or server-chosen
				// process may obtain writing authority through the language channel.
				response := map[string]any{"jsonrpc": "2.0", "id": id}
				if method == "workspace/configuration" {
					response["result"] = session.configuration(value["params"])
				} else {
					response["error"] = map[string]any{"code": -32601, "message": "Factory language operation is unavailable"}
				}
				if session.write(response) != nil {
					break
				}
				continue
			}
			if method != "textDocument/publishDiagnostics" {
				continue
			}
		}
		mapped, err := mapLanguageURIs(value, session.toEditor, true)
		if err != nil {
			// Do not expose backend-local or out-of-Workspace document identities.
			if id, request := value["id"]; request {
				mapped = map[string]any{"jsonrpc": "2.0", "id": id, "result": nil}
			} else {
				continue
			}
		}
		encoded, err := json.Marshal(mapped)
		if err != nil || len(encoded) > maxLanguageBytes {
			break
		}
		if manager.send(Message{Type: "websocket-message", StreamID: streamID, MessageType: websocket.TextMessage, Data: base64.StdEncoding.EncodeToString(encoded)}) != nil {
			break
		}
	}
	manager.send(Message{Type: "stream-close", StreamID: streamID})
}

func (session *languageSession) toEditor(value string) (string, error) {
	uri, err := url.Parse(value)
	if err != nil || uri.Scheme != "file" || uri.Host != "" || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" || !filepath.IsAbs(uri.Path) {
		return "", errors.New("invalid language document")
	}
	canonical, scoped := session.scope.toEditor(value)
	// Dependencies may be runtime-only mounts or live outside the checkout.
	// Never send their file:// identities to the independent Theia backend.
	if scoped == nil && !strings.Contains(uri.Path, "/node_modules/") && !strings.Contains(uri.Path, "/.venv/") {
		return canonical, nil
	}
	virtual := (&url.URL{Scheme: "factory-language", Host: session.scope.workspaceID, Path: "/" + session.attemptID + "/" + session.language + filepath.Clean(uri.Path)}).String()
	session.documentsMu.Lock()
	defer session.documentsMu.Unlock()
	if len(session.documents) >= 4096 && session.documents[virtual] == "" {
		return "", errors.New("language dependency document limit reached")
	}
	session.documents[virtual] = uri.Path
	return virtual, nil
}

func (manager *languageManager) readDocument(streamID string, session *languageSession, request map[string]any) error {
	params, _ := request["params"].(map[string]any)
	uri, _ := params["uri"].(string)
	session.documentsMu.Lock()
	path := session.documents[uri]
	session.documentsMu.Unlock()
	if path == "" || request["id"] == nil {
		return errors.New("only reported dependency documents can be read")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return errors.New("dependency document is unavailable")
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxLanguageBytes {
		return errors.New("dependency document is unavailable or too large")
	}
	text, err := io.ReadAll(io.LimitReader(file, maxLanguageBytes+1))
	if err != nil || len(text) > maxLanguageBytes {
		return errors.New("dependency document is unavailable or too large")
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"text": string(text)}})
	if len(body) > maxLanguageBytes {
		return errors.New("dependency document is too large")
	}
	return manager.send(Message{Type: "websocket-message", StreamID: streamID, MessageType: websocket.TextMessage, Data: base64.StdEncoding.EncodeToString(body)})
}

func (session *languageSession) configuration(params any) []any {
	analysis := map[string]any{"diagnosticMode": "openFilesOnly", "typeCheckingMode": "basic"}
	python := map[string]any{"analysis": analysis}
	// Use the actual Dev Container environment; pyrightconfig/pyproject may
	// further select its project environments. No IDE-local interpreter exists.
	virtualEnvironment := ""
	if session.command != nil {
		for _, entry := range session.command.Env {
			if value, found := strings.CutPrefix(entry, "VIRTUAL_ENV="); found {
				virtualEnvironment = value
				break
			}
		}
	}
	for _, candidate := range []string{filepath.Join(virtualEnvironment, "bin/python"), filepath.Join(session.scope.root, ".venv/bin/python")} {
		if filepath.IsAbs(candidate) {
			if stat, err := os.Stat(candidate); err == nil && !stat.IsDir() {
				python["pythonPath"] = candidate
				break
			}
		}
	}
	root := map[string]any{"python": python, "pyright": map[string]any{}}
	object, _ := params.(map[string]any)
	items, _ := object["items"].([]any)
	results := make([]any, 0, len(items))
	for _, item := range items {
		object, _ := item.(map[string]any)
		switch object["section"] {
		case "python":
			results = append(results, python)
		case "python.analysis":
			results = append(results, analysis)
		case "pyright":
			results = append(results, root["pyright"])
		case "", nil:
			results = append(results, root)
		default:
			results = append(results, nil)
		}
	}
	return results
}

func (manager *languageManager) fail(streamID, message string) {
	_ = manager.send(Message{Type: "stream-error", StreamID: streamID, Error: message})
}

func (manager *languageManager) close(streamID string) bool {
	manager.mutex.Lock()
	session := manager.sessions[streamID]
	delete(manager.sessions, streamID)
	manager.mutex.Unlock()
	if session == nil {
		return false
	}
	session.stopOnce.Do(func() {
		close(session.done)
		session.input.Close()
		StopAssignedProcess(session.command)
	})
	return true
}

func (manager *languageManager) closeAll() {
	manager.mutex.Lock()
	manager.stopping = true
	ids := make([]string, 0, len(manager.sessions))
	for id := range manager.sessions {
		ids = append(ids, id)
	}
	manager.mutex.Unlock()
	for _, id := range ids {
		manager.close(id)
	}
	manager.readers.Wait()
}

func (manager *languageManager) reconnect() {
	manager.mutex.Lock()
	manager.stopping = false
	manager.mutex.Unlock()
}
