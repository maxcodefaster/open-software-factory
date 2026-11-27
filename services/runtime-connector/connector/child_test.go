package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

func TestChildSourceResumeCannotRefreshOrThawFencedWriter(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var refreshes atomic.Int32
	gate := writergate.NewGate(func(context.Context) error {
		refreshes.Add(1)
		return fmt.Errorf("explicit Source resume must not refresh reconnect authority")
	})
	gate.SetFrozen(true)
	peers := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owned-fenced-child" ||
			r.Header.Get("X-Factory-Connector-Role") != "child" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		peer, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		peers <- peer
		<-ctx.Done()
	}))
	assignment := validAssignment()
	assignment.WorkspaceFolder, assignment.Channels = t.TempDir(), nil
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	assignment.SetNativeWriters(gate)
	done := make(chan error, 1)
	go func() { done <- RunChild(ctx, assignment, "owned-fenced-child") }()
	t.Cleanup(func() {
		cancel()
		server.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Error("owned Child did not stop cleanly:", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("owned Child did not join")
		}
	})
	var peer *websocket.Conn
	select {
	case peer = <-peers:
	case <-ctx.Done():
		t.Fatal("fenced Child did not connect")
	}
	deadline, _ := ctx.Deadline()
	peer.SetReadDeadline(deadline)
	peer.SetWriteDeadline(deadline)
	var hello Message
	if err := peer.ReadJSON(&hello); err != nil || hello.Type != "hello" || hello.Role != "child" {
		t.Fatal("fenced Child did not announce its original connection:", err)
	}
	for _, action := range []string{"source-resume", "source-resume", "command-start"} {
		request := Message{Type: "operation-request", Action: action, OperationID: "arbitrary-operation", Data: "{}"}
		if err := peer.WriteJSON(request); err != nil {
			t.Fatal(err)
		}
		var reply Message
		if err := peer.ReadJSON(&reply); err != nil || reply.Type != "operation-response" ||
			reply.OperationID != request.OperationID || reply.Action != action || reply.Error != "native Source writers are fenced" {
			t.Fatalf("retired operation bypassed the Child fence: %+v %v", reply, err)
		}
	}
	started := false
	if refreshes.Load() != 0 || !gate.Frozen() ||
		gate.Start(func() error { started = true; return nil }) == nil || started {
		t.Fatal("arbitrary Source resume refreshed authority or admitted a writer")
	}
}

func TestManagedAppReceivesGracefulStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	directory := t.TempDir()
	assignment := validAssignment()
	assignment.WorkspaceFolder = directory
	assignment.Processes = []Process{{Name: "app", Command: []string{"sh", "-c", "trap 'touch terminated; exit 0' TERM INT; touch ready; while :; do sleep 0.1; done"}}}
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.StopAll()
	if err := manager.Start("app"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(directory, "ready")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("process never became ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := manager.Stop("app"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(directory, "terminated")); err != nil {
		t.Fatal("process did not receive graceful termination")
	}
}

func TestDevelopmentAppHealthDoesNotBlockIDE(t *testing.T) {
	ide := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer ide.Close()
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "app", Kind: "app", Target: "http://127.0.0.1:1", HealthPath: "/"}, {Name: "ide", Kind: "ide", Target: ide.URL, HealthPath: "/"}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := waitForChannels(ctx, assignment, nil); err != nil {
		t.Fatalf("healthy IDE blocked by development App: %v", err)
	}
}

func TestOpenCodePasswordIsLimitedToDeclaredAgentChannel(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "agent", Env: map[string]string{"OPENCODE_PASSWORD": "owned-generation-password"}}}
	for _, kind := range []string{"agent", "app", "ide"} {
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4096/api/info", nil)
		request.Header.Set("Authorization", "Bearer browser-input")
		authorizeAgentRequest(request, Channel{Name: "agent", Kind: kind}, assignment)
		if kind == "agent" {
			user, password, ok := request.BasicAuth()
			if !ok || user != "opencode" || password != "owned-generation-password" {
				t.Fatal("declared Agent did not receive exact server credential")
			}
		} else if request.Header.Get("Authorization") != "Bearer browser-input" {
			t.Fatal("Agent credential escaped into another channel")
		}
	}
}

func TestDevelopmentReadinessNeedsNoRuntimeEditor(t *testing.T) {
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}, {Name: "app", Kind: "app", Target: "http://127.0.0.1:1", HealthPath: "/"}}
	if err := assignment.Validate(); err != nil {
		t.Fatalf("interactive capability still requires a runtime editor: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := waitForChannels(ctx, assignment, nil); err != nil {
		t.Fatalf("connected PTY still waits for an editor or App: %v", err)
	}
}

func TestDevelopmentAgentHealthDoesNotBlockIDE(t *testing.T) {
	ide := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer ide.Close()
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:1", HealthPath: "/api/info"}, {Name: "ide", Kind: "ide", Target: ide.URL, HealthPath: "/"}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := waitForChannels(ctx, assignment, nil); err != nil {
		t.Fatalf("healthy IDE blocked by development Agent: %v", err)
	}
}

func TestDevelopmentChildServesAgentWhilePreviewIsUnhealthy(t *testing.T) {
	// Exercise actual Child admission and HTTP forwarding, not a readiness flag
	// or PID. The controlled Agent endpoint is not real model acceptance.
	checkout := t.TempDir()
	workspace := filepath.Join(checkout, "services", "api")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	preview := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer preview.Close()
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		user, password, ok := request.BasicAuth()
		if !ok || user != "opencode" || password != "owned-agent-readiness-password" {
			http.Error(w, "wrong Agent authority", http.StatusUnauthorized)
			return
		}
		if request.URL.Path != "/api/info" {
			http.NotFound(w, request)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":"2.3.2"}`)
	}))
	defer agent.Close()
	completed := make(chan error, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer owned-agent-before-preview" ||
			request.Header.Get("X-Factory-Connector-Role") != "child" {
			http.Error(w, "wrong Child authority", http.StatusUnauthorized)
			return
		}
		connection, err := upgrader.Upgrade(w, request, nil)
		if err != nil {
			completed <- err
			return
		}
		defer connection.Close()
		connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		var hello Message
		if err := connection.ReadJSON(&hello); err != nil {
			completed <- fmt.Errorf("Preview prevented Child admission: %w", err)
			return
		}
		if hello.Type != "hello" || hello.Role != "child" || len(hello.Channels) != 3 {
			completed <- fmt.Errorf("unexpected Child admission: %#v", hello)
			return
		}
		if err := connection.WriteJSON(Message{Type: "operation-request", OperationID: "observed-context",
			Action: "file-context", Data: "{}"}); err != nil {
			completed <- err
			return
		}
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				completed <- fmt.Errorf("observed Child context unavailable: %w", err)
				return
			}
			if message.OperationID != "observed-context" {
				continue
			}
			var observed struct {
				WorkspaceFolder string `json:"workspaceFolder"`
				CheckoutFolder  string `json:"checkoutFolder"`
				UserID          int    `json:"userID"`
			}
			if message.Type != "operation-response" || message.Action != "file-context" || message.Error != "" ||
				json.Unmarshal([]byte(message.Data), &observed) != nil ||
				observed.WorkspaceFolder != workspace || observed.CheckoutFolder != checkout || observed.UserID != os.Geteuid() {
				completed <- fmt.Errorf("Child context lost its effective directory or user: %#v", message)
				return
			}
			break
		}
		if err := connection.WriteJSON(Message{Type: "http-request", StreamID: "agent-info",
			Channel: "agent", Method: http.MethodGet, Path: "/api/info"}); err != nil {
			completed <- err
			return
		}
		headers := false
		var body strings.Builder
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				completed <- fmt.Errorf("Preview blocked an actual Agent request: %w", err)
				return
			}
			if message.StreamID != "agent-info" {
				continue
			}
			switch message.Type {
			case "http-response":
				headers = message.Status == http.StatusOK
			case "stream-data":
				data, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					completed <- err
					return
				}
				body.Write(data)
			case "stream-end":
				if !headers || body.String() != `{"version":"2.3.2"}` {
					completed <- fmt.Errorf("Agent response unavailable before Preview: headers=%v body=%q", headers, body.String())
				} else {
					completed <- nil
				}
				return
			case "stream-error":
				completed <- fmt.Errorf("Agent forwarding failed: %s", message.Error)
				return
			}
		}
	}))
	defer control.Close()
	assignment := validAssignment()
	assignment.WorkspaceFolder = workspace
	assignment.RemoteWorkspaceFolder = workspace
	assignment.CheckoutFolder = checkout
	assignment.ControlURL = "ws" + strings.TrimPrefix(control.URL, "http")
	assignment.Channels = []Channel{
		{Name: "app", Kind: "app", Target: preview.URL, HealthPath: "/"},
		{Name: "agent", Kind: "agent", Target: agent.URL, HealthPath: "/api/info"},
		{Name: "ide", Kind: "ide"},
	}
	assignment.Processes = []Process{{
		Name: "agent", Command: []string{"sh", "-c", "exec sleep 30"},
		Env: map[string]string{"OPENCODE_PASSWORD": "owned-agent-readiness-password"},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- RunChild(ctx, assignment, "owned-agent-before-preview") }()
	defer func() {
		cancel()
		select {
		case err := <-result:
			if err != nil {
				t.Errorf("Child cleanup failed: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("Child or its owned process survived cancellation")
		}
	}()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("Agent could not respond while Preview remained unhealthy")
	}
}

func TestFailedDevelopmentCommandDoesNotBlockOtherProcesses(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Processes = []Process{{Name: "app", Command: []string{"/factory-missing-command"}}, {Name: "ide", Command: []string{"sh", "-c", "sleep 30"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.StopAll()
	if err := manager.StartAll(); err != nil {
		t.Fatalf("App failure blocked IDE process: %v", err)
	}
	ideState, _, _ := manager.State("ide")
	appState, _, _ := manager.State("app")
	if ideState != "running" || appState != "failed" {
		t.Fatal("independent process states were not retained")
	}
}

func TestFailedDevelopmentAgentDoesNotEndIDE(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}}
	assignment.Processes = []Process{{Name: "agent", Command: []string{"/factory-missing-command"}}, {Name: "ide", Command: []string{"sh", "-c", "sleep 30"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.StopAll()
	if err := manager.StartAll(); err != nil {
		t.Fatalf("Agent failure blocked IDE: %v", err)
	}
	ideState, _, _ := manager.State("ide")
	agentState, _, _ := manager.State("agent")
	if ideState != "running" || agentState != "failed" {
		t.Fatal("independent process states were not retained")
	}
}

func TestVerificationStillRequiresDeclaredChannels(t *testing.T) {
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:1", HealthPath: "/api/info"}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := waitForChannels(ctx, assignment, nil); err == nil {
		t.Fatal("non-development readiness ignored a required channel")
	}
}

func TestDevelopmentChildAcceptsTerminalBeforeAgentReady(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	completed := make(chan error, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owned-terminal-token" || r.Header.Get("X-Factory-Connector-Role") != "child" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			completed <- err
			return
		}
		defer connection.Close()
		connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		var hello Message
		if err := connection.ReadJSON(&hello); err != nil {
			completed <- err
			return
		}
		if hello.Type != "hello" || hello.Role != "child" || hello.Generation != 1 || len(hello.Channels) != 2 {
			completed <- fmt.Errorf("unexpected development hello: %#v", hello)
			return
		}
		if err := connection.WriteJSON(Message{Type: "websocket-open", Channel: "terminal", StreamID: "owned-pty", Path: "/owned-terminal"}); err != nil {
			completed <- err
			return
		}
		var output strings.Builder
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				completed <- fmt.Errorf("Terminal blocked while Agent is unavailable: %w", err)
				return
			}
			if message.StreamID != "owned-pty" {
				continue
			}
			switch message.Type {
			case "websocket-ready":
				err := connection.WriteJSON(Message{Type: "websocket-message", StreamID: "owned-pty", MessageType: websocket.BinaryMessage,
					Data: base64.StdEncoding.EncodeToString([]byte("printf 'child-pty-%s\\n' ready\n"))})
				if err != nil {
					completed <- err
					return
				}
			case "websocket-message":
				data, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					completed <- err
					return
				}
				output.Write(data)
				if strings.Contains(output.String(), "child-pty-ready") {
					completed <- nil
					return
				}
			case "stream-error":
				completed <- fmt.Errorf("Terminal failed: %s", message.Error)
				return
			}
		}
	}))
	defer control.Close()
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.ControlURL = "ws" + strings.TrimPrefix(control.URL, "http")
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:1", HealthPath: "/api/info"}, {Name: "ide", Kind: "ide"}}
	assignment.Processes = []Process{{Name: "agent", Command: []string{"/factory-missing-command"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runResult := make(chan error, 1)
	go func() { runResult <- RunChild(ctx, assignment, "owned-terminal-token") }()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("development Terminal did not become usable independently of OpenCode")
	}
	cancel()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("development child did not stop")
	}
}

func TestTheiaConnectionTokenValidation(t *testing.T) {
	for _, token := range []string{"token", "token-123_A.b~c"} {
		if !validTheiaConnectionToken(token) {
			t.Fatalf("expected token %q to be valid", token)
		}
	}
	for _, token := range []string{"", "bad token", "bad;cookie", strings.Repeat("x", 257)} {
		if validTheiaConnectionToken(token) {
			t.Fatalf("expected token %q to be invalid", token)
		}
	}
}

func TestTerminalSessionSurvivesBrowserDetach(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	messages := make(chan Message, 32)
	manager := newTerminalManager(ctx, assignment, func(message Message) error {
		messages <- message
		return nil
	})
	defer manager.CloseAll()

	manager.Attach(Message{StreamID: "stream-1", Path: "/terminal-a"})
	first := manager.Observation()
	if first.TerminalCount == nil || *first.TerminalCount != 1 || first.TerminalRevision == nil {
		t.Fatal("created PTY has no bounded activity observation")
	}
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "stream-1"
	})
	command := base64.StdEncoding.EncodeToString([]byte("export FACTORY_REATTACH_PROOF=original; printf 'terminal-replay-%s\\n' ok\n"))
	handled, err := manager.Write(Message{
		StreamID:    "stream-1",
		MessageType: websocket.BinaryMessage,
		Data:        command,
	})
	if err != nil || !handled {
		t.Fatalf("write terminal command: handled=%v error=%v", handled, err)
	}
	waitForMessage(t, messages, func(message Message) bool {
		content, _ := base64.StdEncoding.DecodeString(message.Data)
		return message.StreamID == "stream-1" && strings.Contains(string(content), "terminal-replay-ok")
	})
	if !manager.Detach("stream-1") {
		t.Fatal("expected terminal stream to detach")
	}
	detached := manager.Observation()
	if detached.TerminalCount == nil || *detached.TerminalCount != 1 {
		t.Fatal("detaching a browser incorrectly reports an idle PTY")
	}

	manager.Attach(Message{StreamID: "stream-2", Path: "/terminal-a"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "stream-2"
	})
	waitForMessage(t, messages, func(message Message) bool {
		content, _ := base64.StdEncoding.DecodeString(message.Data)
		return message.StreamID == "stream-2" && strings.Contains(string(content), "terminal-replay-ok")
	})
	handled, err = manager.Write(Message{
		StreamID: "stream-2", MessageType: websocket.BinaryMessage,
		Data: base64.StdEncoding.EncodeToString([]byte("printf 'after-reattach=%s\\n' \"$FACTORY_REATTACH_PROOF\"\n")),
	})
	if err != nil || !handled {
		t.Fatalf("write retained terminal: handled=%v error=%v", handled, err)
	}
	waitForMessage(t, messages, func(message Message) bool {
		content, _ := base64.StdEncoding.DecodeString(message.Data)
		return message.StreamID == "stream-2" && strings.Contains(string(content), "after-reattach=original")
	})
	if err := manager.Close("terminal-a"); err != nil {
		t.Fatalf("close terminal session: %v", err)
	}
	if remaining := manager.SessionCount(); remaining != 0 {
		t.Fatalf("expected terminal session to close, got %d", remaining)
	}
	closed := manager.Observation()
	if closed.TerminalCount == nil || *closed.TerminalCount != 0 || closed.TerminalRevision == nil || *closed.TerminalRevision <= *first.TerminalRevision {
		t.Fatal("PTY close did not advance its activity observation")
	}

	manager.Attach(Message{StreamID: "stream-3", Path: "/terminal-b"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "stream-3"
	})
	manager.CloseAll()
	if remaining := manager.SessionCount(); remaining != 0 {
		t.Fatalf("expected workspace stop to close every terminal, got %d", remaining)
	}
}

func TestTerminalLimitRejectsNinthSessionAndCloseFreesCapacity(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	messages := make(chan Message, 256)
	manager := newTerminalManager(ctx, assignment, func(message Message) error {
		messages <- message
		return nil
	})
	defer manager.CloseAll()
	for index := 0; index < 8; index++ {
		stream := fmt.Sprintf("limit-stream-%d", index)
		manager.Attach(Message{StreamID: stream, Path: fmt.Sprintf("/limit-terminal-%d", index)})
		waitForMessage(t, messages, func(message Message) bool {
			return message.Type == "websocket-ready" && message.StreamID == stream
		})
	}
	manager.Attach(Message{StreamID: "ninth", Path: "/ninth"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "stream-error" && message.StreamID == "ninth" && message.Error == "terminal session limit reached"
	})
	ninthCreated := manager.HasSession("ninth")
	count := manager.SessionCount()
	if ninthCreated || count != 8 {
		t.Fatalf("terminal limit created extra work: ninth=%v count=%d", ninthCreated, count)
	}
	if err := manager.Close("limit-terminal-0"); err != nil {
		t.Fatal(err)
	}
	manager.Attach(Message{StreamID: "replacement", Path: "/replacement"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "replacement"
	})
}

func TestManagedAppReportsItsRealExitCode(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Processes = []Process{{
		Name:    "app",
		Command: []string{"sh", "-c", "exit 7"},
	}}
	manager := newProcessManager(ctx, assignment, io.Discard)
	if err := manager.Start("app"); err != nil {
		t.Fatalf("start managed App: %v", err)
	}
	_, _, done := manager.State("app")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for managed App exit")
	}
	state, exitCode, _ := manager.State("app")
	if state != "failed" || exitCode == nil || *exitCode != 7 {
		t.Fatalf("expected failed exit 7, got state=%q exit=%v", state, exitCode)
	}
}

func waitForMessage(t *testing.T, messages <-chan Message, accept func(Message) bool) Message {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case message := <-messages:
			if accept(message) {
				return message
			}
		case <-timer.C:
			t.Fatal("timed out waiting for Connector message")
		}
	}
}

func TestChildWebSocketAppAuthorization(t *testing.T) {
	for _, test := range []struct {
		name, channel, kind, authorization string
		undeclared, invalid                bool
	}{
		{name: "isolated-app", channel: "app", kind: "app", authorization: "Bearer isolated-app"},
		{name: "additional-app", channel: "app-forms", kind: "app", authorization: "Bearer isolated-app"},
		{name: "generic-authorization-stays-stripped", channel: "app", kind: "app"},
		{name: "byte-limit", channel: "app", kind: "app", authorization: "Bearer " + strings.Repeat("x", maxAppAuthorizationBytes-7)},
		{name: "multibyte-limit", channel: "app", kind: "app", authorization: "Basic " + strings.Repeat("é", (maxAppAuthorizationBytes-6)/2)},
		{name: "oversized", channel: "app", kind: "app", authorization: strings.Repeat("x", maxAppAuthorizationBytes+1), invalid: true},
		{name: "multibyte-oversized", channel: "app", kind: "app", authorization: "Basic " + strings.Repeat("é", maxAppAuthorizationBytes/2), invalid: true},
		{name: "CR", channel: "app", kind: "app", authorization: "Bearer isolated-app\rX-Injected: owned", invalid: true},
		{name: "LF", channel: "app", kind: "app", authorization: "Bearer isolated-app\nX-Injected: owned", invalid: true},
		{name: "NUL", channel: "app", kind: "app", authorization: "Bearer isolated-app\x00", invalid: true},
		{name: "tab", channel: "app", kind: "app", authorization: "Bearer isolated\tapp", invalid: true},
		{name: "DEL", channel: "app", kind: "app", authorization: "Bearer isolated-app\x7f", invalid: true},
		{name: "non-byte", channel: "app", kind: "app", authorization: "Bearer isolated-app\u0100", invalid: true},
		{name: "agent", channel: "agent", kind: "agent", authorization: "Bearer isolated-app", invalid: true},
		{name: "ide", channel: "ide", kind: "ide", authorization: "Bearer isolated-app", invalid: true},
		{name: "verification", channel: "verification", kind: "verification", authorization: "Bearer isolated-app", invalid: true},
		{name: "app-name-is-not-app-kind", channel: "app", kind: "agent", authorization: "Bearer isolated-app", invalid: true},
		{name: "undeclared", channel: "app", kind: "app", authorization: "Bearer isolated-app", undeclared: true, invalid: true},
		{name: "terminal", channel: "terminal", kind: "ide", authorization: "Bearer isolated-app", invalid: true},
		{name: "terminal-cannot-alias-app", channel: "terminal", kind: "app", authorization: "Bearer isolated-app", invalid: true},
		{name: "language", channel: "language", kind: "ide", authorization: "Bearer isolated-app", invalid: true},
		{name: "language-cannot-alias-app", channel: "language", kind: "app", authorization: "Bearer isolated-app", invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var upstreamConnections atomic.Int32
			observed := make(chan *http.Request, 1)
			applicationDone := make(chan struct{})
			applicationUpgrader := websocket.Upgrader{
				Subprotocols: []string{"owned-hmr"}, CheckOrigin: func(*http.Request) bool { return true },
			}
			application := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(applicationDone)
				observed <- r.Clone(ctx)
				connection, err := applicationUpgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				stop := context.AfterFunc(ctx, func() { connection.Close() })
				defer stop()
				for {
					kind, data, err := connection.ReadMessage()
					if err != nil || connection.WriteMessage(kind, data) != nil {
						return
					}
				}
			}))
			application.Config.ConnState = func(_ net.Conn, state http.ConnState) {
				if state == http.StateNew {
					upstreamConnections.Add(1)
				}
			}
			application.Start()
			defer application.Close()
			accepted := make(chan *websocket.Conn, 1)
			controlUpgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer child-control-only" {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				connection, err := controlUpgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				accepted <- connection
				<-ctx.Done()
			}))
			defer control.Close()
			dialer := websocket.Dialer{Subprotocols: []string{ConnectorProtocol}}
			child, response, err := dialer.DialContext(ctx, "ws"+strings.TrimPrefix(control.URL, "http"),
				http.Header{"Authorization": {"Bearer child-control-only"}})
			if response != nil {
				response.Body.Close()
			}
			if err != nil {
				t.Fatal("Child control handshake failed", err)
			}
			remote := <-accepted
			_ = remote.SetReadDeadline(time.Now().Add(4 * time.Second))
			defer remote.Close()
			assignment := Assignment{
				WorkspaceFolder: t.TempDir(),
				Channels:        []Channel{{Name: test.channel, Kind: test.kind, Target: application.URL}},
				Processes:       []Process{{Name: "agent", Env: map[string]string{"OPENCODE_PASSWORD": "agent-only-password"}}},
			}
			if test.undeclared {
				assignment.Channels[0].Name = "another-app"
			}
			runtime := &childRuntime{
				assignment: assignment, streams: make(map[string]*websocket.Conn),
				control: newControlConnection(child),
			}
			runtime.terminals = newTerminalManager(ctx, assignment, runtime.send)
			finished := make(chan error, 1)
			go func() { finished <- runtime.readLoop(ctx, runtime.control) }()
			t.Cleanup(func() {
				cancel()
				runtime.closeStream("owned-auth")
				runtime.terminals.CloseAll()
				runtime.control.Close()
				select {
				case <-finished:
				case <-time.After(2 * time.Second):
					t.Error("Child control loop did not stop")
				}
				<-runtime.control.ReaderDone()
			})
			if err := remote.WriteJSON(Message{
				Type: "websocket-open", StreamID: "owned-auth", Channel: test.channel, Path: "/hmr?q=original",
				Protocol: "owned-hmr", AppAuthorization: test.authorization,
				Headers: map[string]string{
					"Authorization":       "Bearer factory-must-not-forward",
					"aUtHoRiZaTiOn":       "Bearer alternate-must-not-forward",
					"Proxy-Authorization": "Bearer parent-must-not-forward",
					"Proxy-Connection":    "keep-alive", "X-Factory-Parent-Token": "parent-only-capability",
					"X-Factory-Connector-Role": "parent", "ATE-Target-Actor": "foreign/actor",
					"Host": "foreign.test", "cookie": "app_session=owned", "X-App": "ordinary",
					"origin": "http://app.factory.invalid",
				},
			}); err != nil {
				t.Fatal("Child WebSocket request failed", err)
			}
			var first Message
			if err := remote.ReadJSON(&first); err != nil {
				t.Fatal("Child WebSocket response unavailable", err)
			}
			if test.invalid {
				if first.Type != "stream-error" || first.StreamID != "owned-auth" || first.Error != "invalid App authorization" {
					t.Fatal("invalid App authorization was not rejected before dispatch")
				}
				if upstreamConnections.Load() != 0 {
					t.Fatal("denied authorization connected to upstream")
				}
				if runtime.terminals.SessionCount() != 0 {
					t.Fatal("App authorization attached a terminal")
				}
				return
			}
			if first.Type != "websocket-ready" || first.StreamID != "owned-auth" || first.Protocol != "owned-hmr" {
				t.Fatal("declared App WebSocket was not confirmed")
			}
			request := <-observed
			wantAuthHeaders := 0
			if test.authorization != "" {
				wantAuthHeaders = 1
			}
			if request.URL.RequestURI() != "/hmr?q=original" ||
				request.Host != strings.TrimPrefix(application.URL, "http://") ||
				request.Header.Get("Authorization") != test.authorization ||
				len(request.Header.Values("Authorization")) != wantAuthHeaders ||
				request.Header.Get("Cookie") != "app_session=owned" || request.Header.Get("X-App") != "ordinary" {
				t.Fatal("Child changed App-only authorization, target or ordinary App headers")
			}
			for _, name := range []string{"Proxy-Authorization", "Proxy-Connection", "X-Factory-Parent-Token", "X-Factory-Connector-Role", "ATE-Target-Actor"} {
				if request.Header.Get(name) != "" {
					t.Fatal("foreign capability header reached App", name)
				}
			}
			for _, kind := range []int{websocket.TextMessage, websocket.BinaryMessage} {
				payload := []byte("owned text")
				if kind == websocket.BinaryMessage {
					payload = []byte{0, 255, 7}
				}
				if err := remote.WriteJSON(Message{Type: "websocket-message", StreamID: "owned-auth",
					MessageType: kind, Data: base64.StdEncoding.EncodeToString(payload)}); err != nil {
					t.Fatal(err)
				}
				var echoed Message
				if err := remote.ReadJSON(&echoed); err != nil {
					t.Fatal("App echo unavailable", err)
				}
				if echoed.Type != "websocket-message" || echoed.MessageType != kind ||
					echoed.Data != base64.StdEncoding.EncodeToString(payload) {
					t.Fatal("authenticated App WebSocket changed a text/binary frame")
				}
			}
			if err := remote.WriteJSON(Message{Type: "stream-close", StreamID: "owned-auth"}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-applicationDone:
			case <-ctx.Done():
				t.Fatal("authenticated App WebSocket did not close")
			}
			if upstreamConnections.Load() != 1 {
				t.Fatal("App handshake was replayed")
			}
		})
	}
}

func TestChildForwardsHTTPAndWebSocket(t *testing.T) {
	applicationUpgrader := websocket.Upgrader{Subprotocols: []string{"vite-hmr"}}
	canceled := make(chan struct{}, 1)
	application := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/health":
			response.WriteHeader(http.StatusNoContent)
		case "/content":
			response.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(response, "connector-http")
		case "/progressive":
			response.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(response, "data: first\n\n")
			response.(http.Flusher).Flush()
			<-request.Context().Done()
			canceled <- struct{}{}
		case "/socket":
			if request.Host != "owned-app.runtime.localhost:58310" ||
				request.Header.Get("Origin") != "http://owned-app.runtime.localhost:58310" ||
				request.Header.Get("Cookie") != "starter.session_token=owned-app" || request.Header.Get("X-Forwarded-Prefix") != "/runtime/owned/app" || request.Header.Get("Authorization") != "" {
				http.Error(response, "App context missing", http.StatusForbidden)
				return
			}
			connection, err := applicationUpgrader.Upgrade(response, request, nil)
			if err != nil {
				return
			}
			defer connection.Close()
			messageType, content, err := connection.ReadMessage()
			if err == nil {
				connection.WriteMessage(messageType, append([]byte("connector-"), content...))
			}
		default:
			http.NotFound(response, request)
		}
	}))
	defer application.Close()

	completed := make(chan error, 1)
	controlUpgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	control := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer short-lived-token" || request.Header.Get("X-Factory-Connector-Role") != "child" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		connection, err := controlUpgrader.Upgrade(response, request, nil)
		if err != nil {
			completed <- err
			return
		}
		defer connection.Close()
		if err := exerciseChildControl(connection); err != nil {
			completed <- err
			return
		}
		select {
		case <-canceled:
			completed <- nil
		case <-time.After(3 * time.Second):
			completed <- fmt.Errorf("Factory cancellation did not reach upstream HTTP")
		}
	}))
	defer control.Close()

	ctx, cancel := context.WithCancel(context.Background())
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.ControlURL = "ws" + strings.TrimPrefix(control.URL, "http")
	assignment.Channels[0].Target = application.URL
	runResult := make(chan error, 1)
	go func() { runResult <- RunChild(ctx, assignment, "short-lived-token") }()

	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("control exchange failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for Connector exchange")
	}
	cancel()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatalf("child failed during shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("child did not stop with its context")
	}
}

func TestChildBoundsFiniteResponsesWithoutTruncatingNativeEventStreams(t *testing.T) {
	for _, test := range []struct {
		name, kind, method, path, contentType string
		streaming                             bool
	}{
		{"events", "agent", "GET", "/api/event", "text/event-stream; charset=utf-8", true},
		{"following-log", "agent", "GET", "/api/session/ses_owned/log?follow=true", "text/event-stream", true},
		{"finite-log", "agent", "GET", "/api/session/ses_owned/log?follow=false", "text/event-stream", false},
		{"app", "app", "GET", "/api/event", "text/event-stream", false},
		{"wrong-type", "agent", "GET", "/api/event", "application/json", false},
		{"other-path", "agent", "GET", "/api/info", "text/event-stream", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			payloadSize := maxResponseBytes + 1024
			application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", test.contentType)
				_, _ = io.CopyN(w, &repeatedByteReader{}, int64(payloadSize))
			}))
			defer application.Close()
			result := make(chan error, 1)
			upgrader := websocket.Upgrader{}
			control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					result <- err
					return
				}
				defer connection.Close()
				total := 0
				for {
					var message Message
					if err := connection.ReadJSON(&message); err != nil {
						result <- err
						return
					}
					if message.Type == "stream-data" {
						data, err := base64.StdEncoding.DecodeString(message.Data)
						if err != nil {
							result <- err
							return
						}
						total += len(data)
					}
					if message.Type == "stream-end" || message.Type == "stream-error" {
						if test.streaming && (message.Type != "stream-end" || total != payloadSize) {
							result <- fmt.Errorf("native stream truncated after %d bytes: %s", total, message.Error)
						} else if !test.streaming && (message.Type != "stream-error" || total > maxResponseBytes) {
							result <- fmt.Errorf("finite response lost its bound: %d bytes, %s", total, message.Type)
						} else {
							result <- nil
						}
						return
					}
				}
			}))
			defer control.Close()
			connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(control.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			runtime := childRuntime{
				assignment: Assignment{Channels: []Channel{{Name: "owned", Kind: test.kind, Target: application.URL}}},
				control:    newControlConnection(connection),
				httpClient: application.Client(),
			}
			runtime.handleHTTPRequest(context.Background(), Message{
				StreamID: "owned", Channel: "owned", Method: test.method, Path: test.path,
			})
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("stream did not settle")
			}
		})
	}
}

type repeatedByteReader struct{}

func (*repeatedByteReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func exerciseChildControl(connection *websocket.Conn) error {
	var hello Message
	if err := connection.ReadJSON(&hello); err != nil {
		return err
	}
	if hello.Type != "hello" || hello.Role != "child" || len(hello.Channels) != 1 {
		return fmt.Errorf("unexpected hello: %#v", hello)
	}
	if err := connection.WriteJSON(Message{
		Type:     "http-request",
		StreamID: "http-1",
		Channel:  "app",
		Method:   http.MethodGet,
		Path:     "/content",
	}); err != nil {
		return err
	}
	var body strings.Builder
	gotHeaders := false
	for {
		var message Message
		if err := connection.ReadJSON(&message); err != nil {
			return err
		}
		if message.StreamID != "http-1" {
			return fmt.Errorf("unexpected HTTP stream: %#v", message)
		}
		switch message.Type {
		case "http-response":
			if message.Status != http.StatusOK || message.Headers["Content-Type"] != "text/plain" {
				return fmt.Errorf("unexpected HTTP response: %#v", message)
			}
			gotHeaders = true
		case "stream-data":
			content, err := base64.StdEncoding.DecodeString(message.Data)
			if err != nil {
				return err
			}
			body.Write(content)
		case "stream-end":
			if !gotHeaders || body.String() != "connector-http" {
				return fmt.Errorf("unexpected HTTP body: %q", body.String())
			}
			goto websocketExchange
		default:
			return fmt.Errorf("unexpected HTTP message: %#v", message)
		}
	}

websocketExchange:
	if err := connection.WriteJSON(Message{
		Type:     "websocket-open",
		StreamID: "ws-1",
		Channel:  "app",
		Path:     "/socket",
		Protocol: "vite-hmr",
		Headers: map[string]string{
			"cookie": "starter.session_token=owned-app", "x-forwarded-prefix": "/runtime/owned/app",
			"x-forwarded-host": "owned-app.runtime.localhost:58310", "x-forwarded-proto": "http",
			"origin": "http://owned-app.runtime.localhost:58310", "authorization": "Bearer must-not-forward",
			"sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
		},
	}); err != nil {
		return err
	}
	var ready Message
	if err := connection.ReadJSON(&ready); err != nil {
		return err
	}
	if ready.Type != "websocket-ready" || ready.StreamID != "ws-1" || ready.Protocol != "vite-hmr" {
		return fmt.Errorf("unexpected WebSocket ready message: %#v", ready)
	}
	if err := connection.WriteJSON(Message{
		Type:        "websocket-message",
		StreamID:    "ws-1",
		MessageType: websocket.TextMessage,
		Data:        base64.StdEncoding.EncodeToString([]byte("ping")),
	}); err != nil {
		return err
	}
	var echoed Message
	if err := connection.ReadJSON(&echoed); err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(echoed.Data)
	if err != nil {
		return err
	}
	if echoed.Type != "websocket-message" || echoed.StreamID != "ws-1" || string(content) != "connector-ping" {
		return fmt.Errorf("unexpected WebSocket echo: %#v", echoed)
	}
	if err := connection.WriteJSON(Message{Type: "stream-close", StreamID: "ws-1"}); err != nil {
		return err
	}
	if err := connection.WriteJSON(Message{Type: "http-request", StreamID: "http-progressive", Channel: "app", Method: http.MethodGet, Path: "/progressive"}); err != nil {
		return err
	}
	connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var message Message
		if err := connection.ReadJSON(&message); err != nil {
			return fmt.Errorf("first chunk did not arrive before stream end: %w", err)
		}
		if message.StreamID != "http-progressive" {
			continue
		}
		if message.Type == "stream-data" {
			data, _ := base64.StdEncoding.DecodeString(message.Data)
			if string(data) != "data: first\n\n" {
				return fmt.Errorf("unexpected progressive chunk: %s", data)
			}
			return connection.WriteJSON(Message{Type: "stream-close", StreamID: "http-progressive"})
		}
		if message.Type != "http-response" {
			return fmt.Errorf("unexpected progressive response: %s", message.Type)
		}
	}
}
