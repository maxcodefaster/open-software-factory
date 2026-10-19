package connector

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestManagedAppReceivesGracefulStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	directory := t.TempDir()
	assignment := validAssignment()
	assignment.WorkspaceFolder = directory
	assignment.Processes = []Process{{Name: "app", Command: []string{"sh", "-c", "trap 'touch terminated; exit 0' TERM INT; touch ready; while :; do sleep 0.1; done"}}}
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.stopAll()
	if err := manager.start("app"); err != nil {
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
	if err := manager.stop("app"); err != nil {
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
	if err := waitForChannels(ctx, assignment); err != nil {
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
	if err := waitForChannels(ctx, assignment); err != nil {
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
	if err := waitForChannels(ctx, assignment); err != nil {
		t.Fatalf("healthy IDE blocked by development Agent: %v", err)
	}
}

func TestFailedDevelopmentCommandDoesNotBlockOtherProcesses(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Processes = []Process{{Name: "app", Command: []string{"/factory-missing-command"}}, {Name: "ide", Command: []string{"sh", "-c", "sleep 30"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.stopAll()
	if err := manager.startAll(); err != nil {
		t.Fatalf("App failure blocked IDE process: %v", err)
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if manager.processes["ide"].state != "running" || manager.processes["app"].state != "failed" {
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
	defer manager.stopAll()
	if err := manager.startAll(); err != nil {
		t.Fatalf("Agent failure blocked IDE: %v", err)
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if manager.processes["ide"].state != "running" || manager.processes["agent"].state != "failed" {
		t.Fatal("independent process states were not retained")
	}
}

func TestVerificationStillRequiresDeclaredChannels(t *testing.T) {
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:1", HealthPath: "/api/info"}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := waitForChannels(ctx, assignment); err == nil {
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

func TestProcessOutputKeepsItsProcessIdentity(t *testing.T) {
	var output bytes.Buffer
	manager := &processManager{
		output: &output,
		recent: make(map[string][]byte),
	}
	writer := managedProcessWriter{name: "app", manager: manager}
	content := []byte("server ready on 4300\n")
	if _, err := writer.Write(content); err != nil {
		t.Fatalf("write process output: %v", err)
	}
	expected := "FACTORY_PROCESS_OUTPUT app " + base64.StdEncoding.EncodeToString(content) + "\n"
	if output.String() != expected {
		t.Fatalf("unexpected process output: %q", output.String())
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
	defer manager.closeAll()

	manager.attach(Message{StreamID: "stream-1", Path: "/terminal-a"})
	first := manager.observation()
	if first.TerminalCount == nil || *first.TerminalCount != 1 || first.TerminalRevision == nil {
		t.Fatal("created PTY has no bounded activity observation")
	}
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "stream-1"
	})
	command := base64.StdEncoding.EncodeToString([]byte("export FACTORY_REATTACH_PROOF=original; printf 'terminal-replay-%s\\n' ok\n"))
	handled, err := manager.write(Message{
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
	if !manager.detach("stream-1") {
		t.Fatal("expected terminal stream to detach")
	}
	detached := manager.observation()
	if detached.TerminalCount == nil || *detached.TerminalCount != 1 {
		t.Fatal("detaching a browser incorrectly reports an idle PTY")
	}

	manager.attach(Message{StreamID: "stream-2", Path: "/terminal-a"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "stream-2"
	})
	waitForMessage(t, messages, func(message Message) bool {
		content, _ := base64.StdEncoding.DecodeString(message.Data)
		return message.StreamID == "stream-2" && strings.Contains(string(content), "terminal-replay-ok")
	})
	handled, err = manager.write(Message{
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
	if err := manager.close("terminal-a"); err != nil {
		t.Fatalf("close terminal session: %v", err)
	}
	manager.mutex.Lock()
	remaining := len(manager.sessions)
	manager.mutex.Unlock()
	if remaining != 0 {
		t.Fatalf("expected terminal session to close, got %d", remaining)
	}
	closed := manager.observation()
	if closed.TerminalCount == nil || *closed.TerminalCount != 0 || closed.TerminalRevision == nil || *closed.TerminalRevision <= *first.TerminalRevision {
		t.Fatal("PTY close did not advance its activity observation")
	}

	manager.attach(Message{StreamID: "stream-3", Path: "/terminal-b"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "websocket-ready" && message.StreamID == "stream-3"
	})
	manager.closeAll()
	manager.mutex.Lock()
	remaining = len(manager.sessions)
	manager.mutex.Unlock()
	if remaining != 0 {
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
	defer manager.closeAll()
	for index := 0; index < 8; index++ {
		stream := fmt.Sprintf("limit-stream-%d", index)
		manager.attach(Message{StreamID: stream, Path: fmt.Sprintf("/limit-terminal-%d", index)})
		waitForMessage(t, messages, func(message Message) bool {
			return message.Type == "websocket-ready" && message.StreamID == stream
		})
	}
	manager.attach(Message{StreamID: "ninth", Path: "/ninth"})
	waitForMessage(t, messages, func(message Message) bool {
		return message.Type == "stream-error" && message.StreamID == "ninth" && message.Error == "terminal session limit reached"
	})
	manager.mutex.Lock()
	_, ninthCreated := manager.sessions["ninth"]
	count := len(manager.sessions)
	manager.mutex.Unlock()
	if ninthCreated || count != 8 {
		t.Fatalf("terminal limit created extra work: ninth=%v count=%d", ninthCreated, count)
	}
	if err := manager.close("limit-terminal-0"); err != nil {
		t.Fatal(err)
	}
	manager.attach(Message{StreamID: "replacement", Path: "/replacement"})
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
	if err := manager.start("app"); err != nil {
		t.Fatalf("start managed App: %v", err)
	}
	manager.mutex.Lock()
	done := manager.processes["app"].done
	manager.mutex.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for managed App exit")
	}
	manager.mutex.Lock()
	process := manager.processes["app"]
	state := process.state
	exitCode := *process.exitCode
	manager.mutex.Unlock()
	if state != "failed" || exitCode != 7 {
		t.Fatalf("expected failed exit 7, got state=%q exit=%d", state, exitCode)
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
			if request.Header.Get("Cookie") != "starter.session_token=owned-app" || request.Header.Get("X-Forwarded-Prefix") != "/runtime/owned/app" || request.Header.Get("Authorization") != "" {
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
				control:    &controlConnection{connection: connection},
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
		Headers:  map[string]string{"cookie": "starter.session_token=owned-app", "x-forwarded-prefix": "/runtime/owned/app", "authorization": "Bearer must-not-forward", "sec-websocket-extensions": "permessage-deflate; client_max_window_bits"},
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
