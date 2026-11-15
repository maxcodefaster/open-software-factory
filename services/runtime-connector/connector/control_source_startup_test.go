package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestControlServesNativeSourceWhileParentBootstrapHasNotStartedReading(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeSource = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Factory-Writer-Epoch") != "17" || r.Header.Get("Authorization") != "" {
			http.Error(w, "wrong Source authority", http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte("canonical-source-before-compute-ready"))
	})
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	result := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer connection.Close()
		for _, kind := range []string{"hello", "status"} {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				result <- err
				return
			}
			if message.Type != kind {
				result <- errors.New("Parent did not announce its original bootstrap")
				return
			}
		}
		// A Git command must remain queued during bootstrap. It must not also
		// prevent an authenticated Source read from reaching the initialized tree.
		for _, message := range []Message{
			{Type: "operation-request", OperationID: "queued-during-bootstrap", Action: "git-status"},
			{Type: "http-request", StreamID: "source-before-ready", Channel: "source",
				Method: http.MethodPost, Path: "/v1/workspaces/owned/read",
				Headers: map[string]string{"x-factory-writer-epoch": "17", "authorization": "forged-browser-token"},
				Data:    base64.StdEncoding.EncodeToString([]byte(`{"path":"README.md"}`))},
		} {
			if err := connection.WriteJSON(message); err != nil {
				result <- err
				return
			}
		}
		var status int
		var body strings.Builder
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				result <- err
				return
			}
			switch message.Type {
			case "http-response":
				status = message.Status
			case "stream-data":
				bytes, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					result <- err
					return
				}
				body.Write(bytes)
			case "stream-end":
				if status != http.StatusOK || body.String() != "canonical-source-before-compute-ready" {
					result <- errors.New("Source did not return its canonical bytes during bootstrap")
				} else {
					result <- nil
				}
				// Keep the connection open until the test consumes the queued
				// command. No bootstrap operation was executed by the reader.
				_, _, _ = connection.ReadMessage()
				return
			case "operation-response":
				result <- errors.New("the transport reader dispatched a bootstrap command")
				return
			}
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "owned-bootstrap-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	for _, message := range []Message{
		{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID,
			Generation: assignment.Generation, Channels: parentChannels(assignment)},
		{Type: "status", Phase: "starting"},
	} {
		if err := control.write(message); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Source was queued behind Parent bootstrap instead of being served")
	}
	var queued Message
	if err := control.read(&queued); err != nil || queued.OperationID != "queued-during-bootstrap" {
		t.Fatalf("Source transport lost or dispatched the queued command: %+v %v", queued, err)
	}
}

func TestControlCancelsNativeSourceDuringBootstrapOnStreamOrSocketClose(t *testing.T) {
	for _, closeSocket := range []bool{false, true} {
		name := "stream-close"
		if closeSocket {
			name = "socket-close"
		}
		t.Run(name, func(t *testing.T) {
			assignment := validAssignment()
			cancelled := make(chan struct{})
			assignment.nativeSource = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(cancelled)
			})
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			peerErrors := make(chan error, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					peerErrors <- err
					return
				}
				defer connection.Close()
				var hello Message
				if err := connection.ReadJSON(&hello); err != nil {
					peerErrors <- err
					return
				}
				if err := connection.WriteJSON(Message{Type: "http-request", StreamID: "startup-watch",
					Channel: "source", Method: http.MethodGet, Path: "/v1/workspaces/owned/events"}); err != nil {
					peerErrors <- err
					return
				}
				var headers Message
				if err := connection.ReadJSON(&headers); err != nil {
					peerErrors <- err
					return
				}
				if headers.Type != "http-response" || headers.Status != http.StatusOK {
					peerErrors <- errors.New("Source watch did not open during bootstrap")
					return
				}
				if closeSocket {
					return
				}
				if err := connection.WriteJSON(Message{Type: "stream-close", StreamID: "startup-watch"}); err != nil {
					peerErrors <- err
					return
				}
				_, _, _ = connection.ReadMessage()
			}))
			defer server.Close()
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			control, err := dialControl(ctx, assignment, "parent", "owned-bootstrap-capability")
			if err != nil {
				t.Fatal(err)
			}
			defer control.close()
			if err := control.write(Message{Type: "hello", Role: "parent"}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-cancelled:
			case err := <-peerErrors:
				t.Fatal(err)
			case <-time.After(time.Second):
				t.Fatal("bootstrap retained a Source stream after its original connection closed")
			}
		})
	}
}
