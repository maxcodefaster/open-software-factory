package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestFailedAppPublishesStartupOutputAndFailsWithoutWaitingForHealthTimeout(t *testing.T) {
	application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer application.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	observed := make(chan []Message, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owned-startup-token" ||
			r.Header.Get("X-Factory-Connector-Role") != "child" {
			http.Error(w, "wrong startup authority", http.StatusUnauthorized)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		deadline, _ := ctx.Deadline()
		connection.SetReadDeadline(deadline.Add(time.Second))
		var messages []Message
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				observed <- messages
				return
			}
			messages = append(messages, message)
			if message.Type == "status" && message.Phase == "failed" {
				observed <- messages
				return
			}
		}
	}))
	defer control.Close()
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.ControlURL = "ws" + strings.TrimPrefix(control.URL, "http")
	assignment.Channels = []Channel{{Name: "app", Kind: "app", Target: application.URL, HealthPath: "/health"}}
	assignment.Processes = []Process{{
		Name: "app", Label: "Owned website",
		Command: []string{"sh", "-c", "printf 'error: missing API_KEY=owned-startup-secret\\n'; exit 7"},
	}}
	version := uint64(1)
	assignment.EnvironmentVersion = &version
	assignment.RuntimeEnvironment = map[string]string{"API_KEY": "owned-startup-secret"}
	err := RunChild(ctx, assignment, "owned-startup-token")
	messages := <-observed
	var output strings.Builder
	var failedState, ready bool
	for _, message := range messages {
		if message.Type == "hello" {
			ready = true
		}
		if message.Type == "process-output" && message.Process == "app" {
			content, decodeErr := base64.StdEncoding.DecodeString(message.Data)
			if decodeErr != nil {
				t.Fatal(decodeErr)
			}
			output.Write(content)
		}
		if message.Type == "process-state" && message.Process == "app" &&
			message.ProcessState == "failed" && message.ExitCode != nil && *message.ExitCode == 7 {
			failedState = true
		}
		if message.Type == "status" && strings.Contains(message.Error, "owned-startup-secret") {
			t.Fatal("startup failure persisted an Environment secret")
		}
	}
	if !strings.Contains(output.String(), "error: missing API_KEY=") || !failedState {
		t.Fatalf("App failure was hidden behind readiness: output=%q failedState=%v", output.String(), failedState)
	}
	if ready {
		t.Fatal("unhealthy App was announced ready")
	}
	if ctx.Err() != nil || err == nil || !strings.Contains(err.Error(), `process "app"`) ||
		!strings.Contains(err.Error(), "7") || !strings.Contains(err.Error(), "missing") ||
		strings.Contains(err.Error(), "owned-startup-secret") {
		t.Fatalf("App exit did not settle with its sanitized cause before the readiness timeout: %v", err)
	}
}

func TestStartupFailureRedactsProcessCredentialsBeforeTheShorterRuntimeValue(t *testing.T) {
	assignment := validAssignment()
	assignment.RuntimeEnvironment = map[string]string{"SHORT_SECRET": "owned-overlap"}
	assignment.Processes = []Process{{
		Name: "app", Env: map[string]string{"OPENCODE_PASSWORD": "owned-overlap-native-password"},
	}}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	code := 9
	manager.processes["app"].state = "failed"
	manager.processes["app"].exitCode = &code
	manager.recent["app"] = []byte("error: native=owned-overlap-native-password runtime=owned-overlap\n")
	err := manager.startupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "code 9") ||
		strings.Contains(err.Error(), "owned-overlap") || strings.Contains(err.Error(), "native-password") ||
		!strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("startup cause leaked a process-local or overlapping credential: %v", err)
	}
}

func TestStartupFailureNeverPublishesThePartialLeadingLineOfItsRollingTail(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "app"}}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	tail := "error: partial-sensitive-value" + strings.Repeat("x", 32<<10) + "\nerror: missing configuration\n"
	manager.recent["app"] = []byte(tail[len(tail)-(32<<10):])
	err := manager.startupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "missing configuration") ||
		strings.Contains(err.Error(), "partial-sensitive-value") || strings.Contains(err.Error(), "xxxx") {
		t.Fatalf("startup cause included an unverifiable partial line: %v", err)
	}
}

func TestChannelTimeoutKeepsHTTPStatusButNeverTheHealthResponseBody(t *testing.T) {
	application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "owned-private-health-body")
	}))
	defer application.Close()
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "app", Kind: "app", Target: application.URL, HealthPath: "/health"}}
	assignment.Processes = []Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{"APP_SECRET": "owned-startup-private-value"}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "running"
	manager.recent["app"] = []byte("Error: missing Content configuration; APP_SECRET=owned-startup-private-value\n")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := waitForChannels(ctx, assignment, manager)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "HTTP 503") ||
		!strings.Contains(err.Error(), "missing Content configuration") ||
		strings.Contains(err.Error(), "owned-startup-private-value") ||
		strings.Contains(err.Error(), "owned-private-health-body") || strings.Contains(err.Error(), application.URL) {
		t.Fatalf("readiness lost its last HTTP status, cancellation cause or privacy boundary: %v", err)
	}
}
