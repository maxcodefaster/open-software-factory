package connector

import (
	"context"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestChildWaitsForFactoryBeforeInitialConnection(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Channels = nil
	observed := make(chan Message, 1)
	var requests atomic.Int32
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Factory-Runtime-Attempt") != assignment.RuntimeAttemptID ||
			r.Header.Get("X-Factory-Runtime-Generation") != "1" ||
			r.Header.Get("Authorization") != "Bearer owned-test-capability" ||
			r.Header.Get("X-Factory-Connector-Role") != "child" {
			t.Error("Child retry changed its admitted capability or identity")
		}
		if requests.Add(1) == 1 {
			http.Error(w, "Factory restarting", http.StatusServiceUnavailable)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		var hello Message
		if err := connection.ReadJSON(&hello); err != nil {
			return
		}
		observed <- hello
		for {
			if _, _, err := connection.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	completed := make(chan error, 1)
	go func() { completed <- RunChild(ctx, assignment, "owned-test-capability") }()
	select {
	case err := <-completed:
		t.Fatalf("Initial Factory downtime killed the admitted child: %v", err)
	case hello := <-observed:
		if hello.Type != "hello" || hello.Role != "child" || hello.AttemptID != assignment.RuntimeAttemptID || hello.Generation != assignment.Generation {
			t.Fatalf("Child changed admitted identity: %#v", hello)
		}
	case <-ctx.Done():
		t.Fatal("Child did not recover its initial connection")
	}
	cancel()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("Child did not stop cleanly: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Child ignored cancellation")
	}
}
