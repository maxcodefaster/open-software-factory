package connector

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type delayedControlCloseConnection struct {
	net.Conn
	pause   *atomic.Bool
	writes  *atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (connection *delayedControlCloseConnection) Close() error {
	if connection.pause.Load() {
		close(connection.started)
		<-connection.release
	}
	return connection.Conn.Close()
}

func (connection *delayedControlCloseConnection) Write(data []byte) (int, error) {
	if connection.pause.Load() {
		connection.writes.Add(1)
	}
	return connection.Conn.Write(data)
}

func TestControlRefusesWritesAfterCloseWasAnnouncedBeforeTCPCloseFinishes(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	started, release := make(chan struct{}), make(chan struct{})
	var pause atomic.Bool
	var writes atomic.Int32
	dialer := websocket.Dialer{
		HandshakeTimeout: time.Second,
		NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			return &delayedControlCloseConnection{
				Conn: connection, pause: &pause, writes: &writes, started: started, release: release,
			}, nil
		},
	}
	connection, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	control := &controlConnection{connection: connection, done: make(chan struct{})}
	joined := make(chan struct{})
	defer func() {
		close(release)
		<-joined
	}()
	pause.Store(true)
	go func() {
		control.close()
		close(joined)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("original TCP close did not start")
	}
	select {
	case <-control.done:
	default:
		t.Fatal("fixture did not reach the announced-close boundary")
	}
	if err := control.write(Message{Type: "status", Phase: "failed", Error: "original producer failed"}); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("a closed control transport accepted another write: %v", err)
	}
	if writes.Load() != 0 {
		t.Fatal("terminal reporting wrote to the already-closed transport")
	}
}

func TestControlAnswersHeartbeatsWhileParentBootstrapHasNotStartedReading(t *testing.T) {
	assignment := validAssignment()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	pong := make(chan struct{}, 1)
	peerErrors := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			peerErrors <- err
			return
		}
		defer connection.Close()
		for _, kind := range []string{"hello", "status"} {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				peerErrors <- err
				return
			}
			if message.Type != kind {
				peerErrors <- errors.New("Parent did not announce its normal startup")
				return
			}
		}
		connection.SetPongHandler(func(value string) error {
			if value == "bootstrap-heartbeat" {
				select {
				case pong <- struct{}{}:
				default:
				}
			}
			return nil
		})
		if err := connection.WriteJSON(Message{Type: "operation-request", OperationID: "queued-during-bootstrap", Action: "git-status"}); err != nil {
			peerErrors <- err
			return
		}
		if err := connection.WriteControl(websocket.PingMessage, []byte("bootstrap-heartbeat"), time.Now().Add(time.Second)); err != nil {
			peerErrors <- err
			return
		}
		for {
			if _, _, err := connection.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "owned-bootstrap-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	for _, message := range []Message{
		{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation},
		{Type: "status", Phase: "starting"},
	} {
		if err := control.write(message); err != nil {
			t.Fatal(err)
		}
	}
	// runParent announces hello/starting, then synchronously prepares images,
	// Features and hooks. No application control.read runs during that work.
	select {
	case <-pong:
	case err := <-peerErrors:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("Parent bootstrap did not read and answer its transport heartbeat")
	}
	var message Message
	if err := control.read(&message); err != nil || message.OperationID != "queued-during-bootstrap" {
		t.Fatalf("transport reading dispatched, lost or reordered the queued operation: %+v %v", message, err)
	}
}

func TestControlReceiveQueueIsBoundedOrderedAndJoinedOnClose(t *testing.T) {
	for _, closeWhileFull := range []bool{false, true} {
		t.Run(map[bool]string{false: "drain in order", true: "close while full"}[closeWhileFull], func(t *testing.T) {
			assignment := validAssignment()
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			const total = controlReadQueueLimit + 24
			sent := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				var hello Message
				if connection.ReadJSON(&hello) != nil {
					return
				}
				for index := range total {
					if connection.WriteJSON(Message{Type: "operation-request", OperationID: fmt.Sprint(index)}) != nil {
						return
					}
				}
				close(sent)
				for {
					if _, _, err := connection.ReadMessage(); err != nil {
						return
					}
				}
			}))
			defer server.Close()
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
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
			case <-sent:
			case <-ctx.Done():
				t.Fatal("fixture did not send its bounded burst")
			}
			until := time.Now().Add(time.Second)
			for len(control.incoming) != controlReadQueueLimit && time.Now().Before(until) {
				time.Sleep(time.Millisecond)
			}
			if cap(control.incoming) != controlReadQueueLimit || len(control.incoming) != controlReadQueueLimit {
				t.Fatal("transport queue did not apply its fixed bound")
			}
			if !closeWhileFull {
				for index := range total {
					var message Message
					if err := control.read(&message); err != nil || message.OperationID != fmt.Sprint(index) {
						t.Fatalf("queued message %d was lost or reordered: %+v %v", index, message, err)
					}
				}
			}
			control.close()
			select {
			case <-control.readerDone:
			case <-ctx.Done():
				t.Fatal("closing the transport did not join its blocked reader")
			}
		})
	}
}

func TestControlPreservesCompleteFramesBeforeEOFButRefusesNewWrites(t *testing.T) {
	assignment := validAssignment()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		var hello Message
		if connection.ReadJSON(&hello) != nil {
			return
		}
		for _, kind := range []string{"fixture-message", "stop"} {
			if connection.WriteJSON(Message{Type: kind}) != nil {
				return
			}
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
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
	case <-control.readerDone:
	case <-ctx.Done():
		t.Fatal("peer EOF did not finish its reader")
	}
	for _, kind := range []string{"fixture-message", "stop"} {
		var message Message
		if err := control.read(&message); err != nil || message.Type != kind {
			t.Fatalf("complete frame before EOF was lost: %+v %v", message, err)
		}
	}
	var message Message
	if err := control.read(&message); err == nil {
		t.Fatal("closed transport supplied an invented message")
	}
	if err := control.write(Message{Type: "status", Phase: "ready"}); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("EOF allowed a new readiness report: %v", err)
	}
}

func TestControlKeepaliveHasHeadroomInsideTheNativeProxyIdleWindow(t *testing.T) {
	// The production proxy idles out after 30s. Scale both actual configured
	// intervals equally, and retain some handshake/scheduling time before the
	// ticker starts. Equal 30s timers cannot keep this connection alive.
	const scale = 100
	const idle = 30 * time.Second / scale
	assignment := validAssignment()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	result := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		var hello Message
		if err := connection.ReadJSON(&hello); err != nil {
			connection.Close()
			result <- err
			return
		}
		_ = connection.SetReadDeadline(time.Now().Add(idle))
		connection.SetPingHandler(func(data string) error {
			_ = connection.SetReadDeadline(time.Now().Add(idle))
			return connection.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
		})
		readError := make(chan error, 1)
		joined := make(chan struct{})
		go func() {
			defer close(joined)
			for {
				if _, _, err := connection.ReadMessage(); err != nil {
					readError <- err
					return
				}
			}
		}()
		defer func() { connection.Close(); <-joined }()
		timer := time.NewTimer(2 * idle)
		defer timer.Stop()
		select {
		case <-timer.C:
			result <- connection.WriteJSON(Message{Type: "fixture-complete"})
		case err := <-readError:
			result <- fmt.Errorf("proxy idle window elapsed before the next keepalive: %w", err)
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "owned-idle-window-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	if err := control.write(Message{Type: "hello", Role: "parent"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(idle / 4)
	go control.keepAlive(ctx, controlPingInterval/scale)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("proxy-window fixture did not finish")
	}
	var message Message
	if err := control.read(&message); err != nil || message.Type != "fixture-complete" {
		t.Fatalf("idle preparation lost its original transport: %+v %v", message, err)
	}
	if controlReadTimeout != 90*time.Second {
		t.Fatal("keepalive headroom changed the normal half-open read deadline")
	}
}
