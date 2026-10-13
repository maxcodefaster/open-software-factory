package connector

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type recoveryRoundTripper func(*http.Request) (*http.Response, error)

func (transport recoveryRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestFailedRecoveryReadDoesNotPoisonAgentAdmission(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			requests := 0
			assignment := validAssignment()
			assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:1", HealthPath: "/health"}}
			runtime := &childRuntime{
				assignment:    assignment,
				agentRequests: make(chan func(), 16),
				httpClient: &http.Client{Transport: recoveryRoundTripper(func(request *http.Request) (*http.Response, error) {
					requests++
					if requests == 1 {
						return nil, fmt.Errorf("owned pre-header response loss")
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[],"hasMore":false}`))}, nil
				})},
			}
			path := "/api/session/owned/inbox"
			if method == http.MethodPost {
				path = "/api/session/owned/prompt"
			}
			for _, message := range []Message{
				{StreamID: "lost", Channel: "agent", Method: method, Path: path},
				{StreamID: "retry", Channel: "agent", Method: http.MethodGet, Path: "/api/session/owned/inbox"},
				{StreamID: "later", Channel: "agent", Method: http.MethodPost, Path: "/api/session/owned/interrupt"},
			} {
				runtime.startHTTPRequest(context.Background(), message)
				select {
				case execute := <-runtime.agentRequests:
					execute()
				case <-time.After(time.Second):
					t.Fatal("recovery request did not enter the ordered queue")
				}
			}
			if method == http.MethodGet {
				if runtime.agentUncertain || requests != 3 {
					t.Fatalf("failed read blocked recovery: uncertain=%v requests=%d", runtime.agentUncertain, requests)
				}
			} else if !runtime.agentUncertain || requests != 1 {
				t.Fatalf("unknown mutation permitted later execution: uncertain=%v requests=%d", runtime.agentUncertain, requests)
			}
		})
	}
}

func TestAgentInterruptCannotOvertakePromptAdmission(t *testing.T) {
	testAgentRecoveryOrdering(t, false)
}

func TestAgentInboxCannotOvertakePromptAdmission(t *testing.T) {
	testAgentRecoveryOrdering(t, true)
}

func testAgentRecoveryOrdering(t *testing.T, history bool) {
	t.Helper()
	for _, loss := range []string{"none", "stream-close", "reconnect", "lost-response"} {
		t.Run(loss, func(t *testing.T) {
			entered := make(chan struct{})
			admitted := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			releasePrompt := func() { releaseOnce.Do(func() { close(release) }) }
			defer releasePrompt()
			interrupts := make(chan bool, 1)
			application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/health":
					w.WriteHeader(http.StatusNoContent)
				case "/api/session/owned/prompt":
					if loss == "lost-response" {
						connection, _, err := w.(http.Hijacker).Hijack()
						if err == nil {
							connection.Close()
						}
					}
					close(entered)
					// Pinned OpenCode admission is uninterruptible. Disconnecting
					// its HTTP caller does not prove rejection of the input.
					<-release
					close(admitted)
					if loss != "lost-response" {
						fmt.Fprint(w, `{"data":{"id":"owned-prompt"}}`)
					}
				case "/api/session/owned/interrupt", "/api/session/owned/inbox":
					select {
					case <-admitted:
						interrupts <- false
					default:
						interrupts <- true
					}
					if strings.HasSuffix(r.URL.Path, "/inbox") {
						fmt.Fprint(w, `[{"id":"owned-prompt"}]`)
					} else {
						w.WriteHeader(http.StatusNoContent)
					}
				default:
					http.NotFound(w, r)
				}
			}))
			defer application.Close()

			completed := make(chan error, 1)
			var connections atomic.Int32
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					completed <- err
					return
				}
				defer connection.Close()
				connection.SetReadDeadline(time.Now().Add(5 * time.Second))
				var hello Message
				if err := connection.ReadJSON(&hello); err != nil {
					completed <- err
					return
				}
				if hello.Type != "hello" || hello.Role != "child" {
					completed <- fmt.Errorf("missing child hello")
					return
				}
				if connections.Add(1) == 1 {
					if err := connection.WriteJSON(Message{Type: "http-request", StreamID: "prompt", Channel: "agent", Method: http.MethodPost, Path: "/api/session/owned/prompt"}); err != nil {
						completed <- err
						return
					}
					select {
					case <-entered:
					case <-time.After(3 * time.Second):
						completed <- fmt.Errorf("prompt did not reach upstream")
						return
					}
					if loss == "reconnect" {
						return
					}
					if loss == "stream-close" {
						if err := connection.WriteJSON(Message{Type: "stream-close", StreamID: "prompt"}); err != nil {
							completed <- err
							return
						}
					}
				}
				completed <- exerciseHeldAgentAdmission(connection, interrupts, releasePrompt, loss == "lost-response", history)
			}))
			defer control.Close()

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			assignment := validAssignment()
			assignment.WorkspaceFolder = t.TempDir()
			assignment.ControlURL = "ws" + strings.TrimPrefix(control.URL, "http")
			assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: application.URL, HealthPath: "/health"}}
			runResult := make(chan error, 1)
			go func() { runResult <- RunChild(ctx, assignment, "owned-test-token") }()
			select {
			case err := <-completed:
				if err != nil {
					t.Error(err)
				}
			case <-time.After(10 * time.Second):
				t.Error("agent forwarding test timed out")
			}
			releasePrompt()
			cancel()
			select {
			case err := <-runResult:
				if err != nil {
					t.Error(err)
				}
			case <-time.After(5 * time.Second):
				t.Error("child did not stop")
			}
		})
	}
}

func exerciseHeldAgentAdmission(connection *websocket.Conn, interrupts <-chan bool, release func(), uncertain, history bool) error {
	defer release()
	proof := Message{Type: "http-request", StreamID: "interrupt", Channel: "agent", Method: http.MethodPost, Path: "/api/session/owned/interrupt"}
	expectedStatus := http.StatusNoContent
	if history {
		proof.Method = http.MethodGet
		proof.Path = "/api/session/owned/inbox"
		expectedStatus = http.StatusOK
	}
	for _, request := range []Message{
		proof,
		{Type: "http-request", StreamID: "health", Channel: "agent", Method: http.MethodGet, Path: "/health"},
	} {
		if err := connection.WriteJSON(request); err != nil {
			return err
		}
	}
	// A read remains responsive while a mutation is held. Its response also
	// establishes that the read loop consumed the preceding interrupt frame.
	interruptError := ""
	interruptAcknowledged := false
	for {
		var message Message
		if err := connection.ReadJSON(&message); err != nil {
			return err
		}
		if message.StreamID == "interrupt" && message.Type == "stream-error" {
			interruptError = message.Error
		}
		if message.StreamID == "interrupt" && message.Type == "http-response" {
			interruptAcknowledged = true
		}
		if message.StreamID == "health" && message.Type == "stream-end" {
			break
		}
	}
	if uncertain {
		if interruptAcknowledged {
			return fmt.Errorf("unknown admission permitted an interrupt acknowledgement")
		}
		for interruptError == "" {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				return err
			}
			if message.StreamID == "interrupt" && message.Type == "http-response" {
				return fmt.Errorf("unknown admission permitted an interrupt acknowledgement")
			}
			if message.StreamID == "interrupt" && message.Type == "stream-error" {
				interruptError = message.Error
			}
		}
		if !strings.Contains(interruptError, "uncertain") {
			return fmt.Errorf("uncertain admission was not explained: %s", interruptError)
		}
		select {
		case <-interrupts:
			return fmt.Errorf("unknown admission still reached upstream interrupt")
		default:
			return nil
		}
	}
	select {
	case early := <-interrupts:
		if early {
			return fmt.Errorf("interrupt acknowledged before prior prompt admission; later input can revive stopped work")
		}
		return fmt.Errorf("held prompt was unexpectedly admitted")
	case <-time.After(100 * time.Millisecond):
	}
	release()
	select {
	case early := <-interrupts:
		if early {
			return fmt.Errorf("interrupt overtook prompt admission")
		}
	case <-time.After(3 * time.Second):
		return fmt.Errorf("interrupt did not follow completed admission")
	}
	for {
		var message Message
		if err := connection.ReadJSON(&message); err != nil {
			return err
		}
		if message.StreamID == "interrupt" && message.Type == "http-response" && message.Status != expectedStatus {
			return fmt.Errorf("interrupt returned %d", message.Status)
		}
		if message.StreamID == "interrupt" && message.Type == "stream-end" {
			return nil
		}
	}
}

func TestChildShutdownJoinsWorkerWhileAgentAdmissionIsHeld(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	admitted := make(chan struct{})
	var releaseOnce sync.Once
	releasePrompt := func() { releaseOnce.Do(func() { close(release) }) }
	application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		close(entered)
		// Upstream admission ignores caller cancellation. Child shutdown must
		// join its own HTTP observer without waiting for this handler to finish.
		<-release
		close(admitted)
		fmt.Fprint(w, `{"data":{"id":"owned-prompt"}}`)
	}))
	defer application.Close()
	defer releasePrompt()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		connection.SetReadDeadline(time.Now().Add(5 * time.Second))
		var hello Message
		if err := connection.ReadJSON(&hello); err != nil {
			t.Error(err)
			return
		}
		if err := connection.WriteJSON(Message{Type: "http-request", StreamID: "held-prompt", Channel: "agent", Method: http.MethodPost, Path: "/api/session/owned/prompt"}); err != nil {
			t.Error(err)
			return
		}
		var message Message
		_ = connection.ReadJSON(&message)
	}))
	defer control.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.ControlURL = "ws" + strings.TrimPrefix(control.URL, "http")
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent", Target: application.URL, HealthPath: "/health"}}
	result := make(chan error, 1)
	go func() { result <- RunChild(ctx, assignment, "owned-test-token") }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("held admission did not reach upstream")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("child did not join its held Agent observer on shutdown")
	}
	select {
	case <-admitted:
		t.Fatal("shutdown proof unexpectedly released upstream admission")
	default:
	}
}
