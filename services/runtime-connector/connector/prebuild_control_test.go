package connector

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestPrebuildControlReconnectsAndReadsHeartbeatsWithoutRepeatingTheProducer(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "stop"}[stop], func(t *testing.T) {
			assignment := validAssignment()
			started, release, pong := make(chan struct{}), make(chan struct{}), make(chan struct{})
			finished := make(chan struct{})
			var calls, sockets atomic.Int32
			var once sync.Once
			messages := make(chan Message, 8)
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				if sockets.Add(1) == 1 {
					<-started
					return
				}
				defer close(finished)
				connection.SetPongHandler(func(string) error {
					once.Do(func() {
						close(pong)
						if !stop {
							close(release)
						}
					})
					if stop {
						return connection.WriteJSON(Message{Type: "stop"})
					}
					return nil
				})
				if connection.WriteControl(websocket.PingMessage, []byte("producer-heartbeat"), time.Now().Add(time.Second)) != nil {
					return
				}
				for {
					var message Message
					if connection.ReadJSON(&message) != nil {
						return
					}
					messages <- message
				}
			}))
			defer server.Close()
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			control, err := dialControl(ctx, assignment, "parent", "owned-producer-capability")
			if err != nil {
				t.Fatal(err)
			}
			err = servePrebuildControl(ctx, assignment, "owned-producer-capability", control, func(ctx context.Context) error {
				calls.Add(1)
				close(started)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			})
			if stop {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("Stop did not cancel and join the producer: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 || sockets.Load() != 2 {
				t.Fatalf("producer was repeated or transport was not reconnected: calls=%d sockets=%d", calls.Load(), sockets.Load())
			}
			select {
			case <-pong:
			default:
				t.Fatal("producer did not read and answer the heartbeat")
			}
			select {
			case <-finished:
			case <-ctx.Done():
				t.Fatal("producer control reader did not finish")
			}
			var hello, final bool
			for len(messages) > 0 {
				message := <-messages
				if message.Type == "child-started" {
					t.Fatal("prebuild invented a Child connection")
				}
				if message.Type == "hello" {
					hello = message.Role == "parent" && message.AttemptID == assignment.RuntimeAttemptID
				}
				if message.Type == "status" && (message.Phase == "stopped" || message.Phase == "failed") {
					final = true
				}
			}
			if !hello || !final {
				t.Fatal("reconnected producer did not report its own role and final outcome")
			}
		})
	}
}

func TestPrebuildReportsFailureAfterTheProducerFinishesOnADisconnectedSocket(t *testing.T) {
	assignment := validAssignment()
	var calls, sockets atomic.Int32
	reported := make(chan Message, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		if sockets.Add(1) == 1 {
			return
		}
		var hello, status Message
		if connection.ReadJSON(&hello) != nil || connection.ReadJSON(&status) != nil {
			return
		}
		if hello.Type == "hello" && hello.Role == "parent" && hello.AttemptID == assignment.RuntimeAttemptID {
			reported <- status
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "owned-producer-capability")
	if err != nil {
		t.Fatal(err)
	}
	want := errors.New("Project prebuild failed; original invocation is complete")
	err = servePrebuildControl(ctx, assignment, "owned-producer-capability", control, func(ctx context.Context) error {
		calls.Add(1)
		select {
		case <-control.done:
			return want
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if !errors.Is(err, want) || calls.Load() != 1 || sockets.Load() != 2 {
		t.Fatalf("terminal reporting changed the result or repeated the producer: %v calls=%d sockets=%d", err, calls.Load(), sockets.Load())
	}
	select {
	case status := <-reported:
		if status.Type != "status" || status.Phase != "failed" || status.Error != want.Error() {
			t.Fatalf("lost original producer failure: %+v", status)
		}
	case <-ctx.Done():
		t.Fatal("terminal failure was not reported over the replacement transport")
	}
}
