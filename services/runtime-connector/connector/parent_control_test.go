package connector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestParentControlRejectsObsoleteBrowserExecution(t *testing.T) {
	for _, action := range []string{
		"browser-call", "browser-renew", "browser-close",
		"browser-recording-start", "browser-recording-finish", "browser-recording-chunk",
	} {
		message := Message{Type: "operation-request", OperationID: "retired-browser-request", Action: action}
		response := handleParentOperation(context.Background(), validAssignment(), message)
		if response.Type != "operation-response" || response.OperationID != message.OperationID ||
			response.Action != action || response.Error != "unsupported parent operation" || response.Data != "" {
			t.Fatalf("Parent retained an obsolete browser execution route: %+v", response)
		}
	}
}

func TestParentOperationsRunInOrderAndReportAFullQueue(t *testing.T) {
	release := make(chan struct{})
	operations := startParentOperations(context.Background(), func(_ context.Context, message Message) Message {
		if message.OperationID == "first" {
			<-release
		}
		return Message{Type: "operation-response", OperationID: message.OperationID}
	})
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	responses := make(chan Message, parentOperationQueueLimit+2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			var message Message
			if connection.ReadJSON(&message) != nil {
				return
			}
			responses <- message
		}
	}))
	defer server.Close()
	assignment := validAssignment()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	control, err := dialControl(context.Background(), assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	if !operations.submit(control, Message{OperationID: "first"}) {
		t.Fatal("first operation was refused")
	}
	// The worker may not have dequeued "first" yet, so allow one extra slot.
	accepted := 0
	for index := 0; index < parentOperationQueueLimit+2; index++ {
		if operations.submit(control, Message{OperationID: "queued"}) {
			accepted++
		}
	}
	if accepted < parentOperationQueueLimit || accepted > parentOperationQueueLimit+1 {
		t.Fatalf("queue admitted %d operations; it must stay bounded", accepted)
	}
	close(release)
	select {
	case message := <-responses:
		if message.OperationID != "first" {
			t.Fatalf("operations ran out of order: %#v", message)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("first operation never responded")
	}
	operations.stop()
}

func TestControlReadDeadlineDetectsHalfOpenSockets(t *testing.T) {
	assignment := validAssignment()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		// A peer that never reads cannot answer pings with pongs.
		<-release
	}))
	defer server.Close()
	defer close(release)
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	control, err := dialControl(context.Background(), assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	control.ArmReadDeadline(200 * time.Millisecond)
	started := time.Now()
	var message Message
	if err := control.Read(&message); err == nil {
		t.Fatal("a silent peer was never detected")
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("half-open detection ignored the read deadline")
	}
}

func TestControlPingsKeepAnIdleSocketAlive(t *testing.T) {
	assignment := validAssignment()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		go func() {
			for {
				if _, _, err := connection.ReadMessage(); err != nil {
					return
				}
			}
		}()
		for range 8 {
			time.Sleep(100 * time.Millisecond)
			if connection.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)) != nil {
				return
			}
		}
		connection.WriteJSON(Message{Type: "stop"})
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	control, err := dialControl(context.Background(), assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	control.ArmReadDeadline(300 * time.Millisecond)
	var message Message
	if err := control.Read(&message); err != nil || message.Type != "stop" {
		t.Fatalf("heartbeat did not keep an idle socket alive for 800ms with a 300ms deadline: %v, %#v", err, message)
	}
}

func TestReconnectBackoffGrowsWithJitterAndResets(t *testing.T) {
	var backoff reconnectBackoff
	floor := controlReconnectMin
	for attempt := 0; attempt < 12; attempt++ {
		delay := backoff.Next()
		if delay < floor || delay > floor+floor/2 {
			t.Fatalf("attempt %d waited %v; expected %v plus up to 50%% jitter", attempt, delay, floor)
		}
		floor = min(floor*2, controlReconnectMax)
	}
	if floor != controlReconnectMax {
		t.Fatal("backoff never reached its cap")
	}
	backoff.Reset()
	if delay := backoff.Next(); delay > controlReconnectMin+controlReconnectMin/2 {
		t.Fatalf("reset did not restart backoff: %v", delay)
	}
	seen := map[time.Duration]bool{}
	for range 20 {
		var fresh reconnectBackoff
		seen[fresh.Next()] = true
	}
	if len(seen) < 2 {
		t.Fatal("reconnect delays have no jitter")
	}
}
