package connector

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type failedBrowserResponseConnection struct {
	net.Conn
	fail *atomic.Bool
}

func (connection *failedBrowserResponseConnection) Write(data []byte) (int, error) {
	if connection.fail.Load() && len(data) > 0 && data[0]&0xf == websocket.TextMessage {
		return 0, errors.New("injected failed browser response write")
	}
	return connection.Conn.Write(data)
}

func TestBrowserControlResponseFailureClosesItsExactConnection(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "healthy response", true: "failed response with live reader"}[failed], func(t *testing.T) {
			accepted := make(chan *websocket.Conn, 1)
			finished := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				accepted <- connection
				<-finished
			}))
			defer server.Close()
			defer close(finished)
			var fail atomic.Bool
			dialer := websocket.Dialer{
				HandshakeTimeout: time.Second,
				NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
					connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
					if err != nil {
						return nil, err
					}
					return &failedBrowserResponseConnection{Conn: connection, fail: &fail}, nil
				},
			}
			connection, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			control := &controlConnection{connection: connection, done: make(chan struct{})}
			defer control.close()
			peer := <-accepted
			// The server-to-client direction stays live. A failed data response
			// must not leave Parent blocked reading more requests on that socket.
			if err := peer.WriteJSON(Message{Type: "fixture-ready"}); err != nil {
				t.Fatal(err)
			}
			var ready Message
			if err := connection.ReadJSON(&ready); err != nil || ready.Type != "fixture-ready" {
				t.Fatal("fixture reader was not live", err)
			}
			manager, scope := browserRuntimeFixture(t)
			fail.Store(failed)
			authority, cancelAuthority := browserConnectionContext(context.Background())
			defer cancelAuthority()
			handleBrowserControlOperation(authority, cancelAuthority, control, manager, browserScopeMessage(manager, scope, "browser-renew"))
			if (authority.Err() != nil) != failed {
				t.Fatal("browser authority did not follow this exact response connection")
			}
			select {
			case <-control.done:
				if !failed {
					t.Fatal("a healthy browser response closed its connection")
				}
			default:
				if failed {
					t.Fatal("failed browser response left the control reader live instead of recovering the connection")
				}
				var response Message
				if err := peer.ReadJSON(&response); err != nil || response.Type != "operation-response" || response.Action != "browser-renew" {
					t.Fatal("healthy browser response was not delivered", err)
				}
			}
		})
	}
}
