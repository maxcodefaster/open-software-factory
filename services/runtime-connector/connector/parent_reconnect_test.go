package connector

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestStartupFailureReconnectReportsOnlyTheOriginalOutcome(t *testing.T) {
	for _, scenario := range []string{"accepted", "open", "revoked", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			assignment := validAssignment()
			observed := make(chan []Message, 1)
			var requests atomic.Int32
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count := requests.Add(1)
				if r.Header.Get("Authorization") != "Bearer original-capability" ||
					r.Header.Get("X-Factory-Runtime-Attempt") != assignment.RuntimeAttemptID ||
					r.Header.Get("X-Factory-Runtime-Generation") != "1" || r.Header.Get("X-Factory-Connector-Role") != "parent" {
					t.Error("Failure reporting changed admitted authority")
				}
				if scenario == "revoked" && count > 1 {
					http.Error(w, "Revoked", http.StatusForbidden)
					return
				}
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				var messages []Message
				for len(messages) < 2 {
					var message Message
					if connection.ReadJSON(&message) != nil {
						return
					}
					messages = append(messages, message)
				}
				observed <- messages
			}))
			defer server.Close()
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			control, err := dialControl(ctx, assignment, "parent", "original-capability")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { control.close() }()
			if scenario != "open" {
				control.close()
			}
			if scenario == "cancelled" {
				cancel()
			}
			reportParentStartupFailure(ctx, assignment, "original-capability", &control, errors.New("original Feature failed"))
			expectedRequests := int32(2)
			if scenario == "cancelled" {
				expectedRequests = 1
			}
			if requests.Load() != expectedRequests {
				t.Fatalf("Failure reporting repeated or dispatched after cancellation: %d", requests.Load())
			}
			if scenario == "accepted" || scenario == "open" {
				select {
				case messages := <-observed:
					if messages[0].Type != "hello" || messages[0].AttemptID != assignment.RuntimeAttemptID || messages[0].Generation != assignment.Generation ||
						messages[1].Type != "status" || messages[1].Phase != "failed" || messages[1].Error != "original Feature failed" {
						t.Fatalf("Reconnect changed the original failure: %#v", messages)
					}
				case <-ctx.Done():
					t.Fatal("Original startup failure was not reported")
				}
			}
		})
	}
}

func TestChildStartedSurvivesControlLossDuringStartup(t *testing.T) {
	assignment := validAssignment()
	observed := make(chan []Message, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Factory-Runtime-Attempt") != assignment.RuntimeAttemptID ||
			r.Header.Get("X-Factory-Runtime-Generation") != "1" ||
			r.Header.Get("Authorization") != "Bearer owned-test-capability" ||
			r.Header.Get("X-Factory-Connector-Role") != "parent" {
			t.Error("Reconnect changed admitted identity or role")
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		var messages []Message
		for len(messages) < 2 {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				return
			}
			messages = append(messages, message)
		}
		observed <- messages
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	// The control plane disappears while native Dev Container startup is running.
	// Returning from this production call site would run RunParent's stack teardown.
	control.close()
	defer func() { control.close() }()
	if err := announceChildStarted(ctx, assignment, "owned-test-capability", &control); err != nil {
		t.Fatalf("Startup connection loss would destroy admitted compute: %v", err)
	}
	select {
	case messages := <-observed:
		if messages[0].Type != "hello" || messages[0].AttemptID != assignment.RuntimeAttemptID ||
			messages[0].Generation != assignment.Generation || messages[1].Phase != "child-started" {
			t.Fatalf("Reconnect did not replay exact startup readiness: %#v", messages)
		}
	case <-ctx.Done():
		t.Fatal("Reconnect did not announce native child readiness")
	}
}

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

func TestStartupReconnectHonorsCancellation(t *testing.T) {
	assignment := validAssignment()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) != 1 {
			http.Error(w, "Factory restarting", http.StatusServiceUnavailable)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			if _, _, err := connection.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	control.close()
	completed := make(chan error, 1)
	go func() { completed <- announceChildStarted(ctx, assignment, "owned-test-capability", &control) }()
	cancel()
	select {
	case err := <-completed:
		if err != context.Canceled {
			t.Fatalf("Parent ignored cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Parent reconnect did not stop")
	}
}
