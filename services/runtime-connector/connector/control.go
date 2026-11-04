package connector

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type controlConnection struct {
	connection  *websocket.Conn
	readTimeout time.Duration
	writeLock   sync.Mutex
	closeOnce   sync.Once
	done        chan struct{}
}

func dialControl(ctx context.Context, assignment Assignment, role string, token string) (*controlConnection, error) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+token)
	headers.Set("X-Factory-Runtime-Attempt", assignment.RuntimeAttemptID)
	headers.Set("X-Factory-Runtime-Generation", fmt.Sprint(assignment.Generation))
	headers.Set("X-Factory-Connector-Role", role)
	dialer := websocket.Dialer{
		HandshakeTimeout: controlHandshakeTimeout,
		Subprotocols:     []string{ConnectorProtocol},
	}
	connection, response, err := dialer.DialContext(ctx, assignment.ControlURL, headers)
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("connect to Factory: %w", err)
	}
	if connection.Subprotocol() != ConnectorProtocol {
		connection.Close()
		return nil, fmt.Errorf("Factory did not select %s", ConnectorProtocol)
	}
	connection.SetReadLimit(maxControlBytes)
	control := &controlConnection{connection: connection, done: make(chan struct{})}
	control.armReadDeadline(controlReadTimeout)
	go control.keepAlive(ctx)
	return control, nil
}

// Every frame from Factory, including its pong replies to our pings, extends
// the read deadline. A socket that goes silent for controlReadTimeout is
// half-open and its blocked read fails so the caller can reconnect.
func (control *controlConnection) armReadDeadline(timeout time.Duration) {
	control.readTimeout = timeout
	extend := func() error {
		return control.connection.SetReadDeadline(time.Now().Add(timeout))
	}
	_ = extend()
	control.connection.SetPongHandler(func(string) error { return extend() })
	control.connection.SetPingHandler(func(data string) error {
		_ = extend()
		err := control.connection.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(controlWriteTimeout))
		if err == websocket.ErrCloseSent {
			return nil
		}
		return err
	})
}

// read blocks for the next control message. Use it instead of reading the
// socket directly so the heartbeat deadline is refreshed for each message.
func (control *controlConnection) read(message *Message) error {
	if control.readTimeout > 0 {
		_ = control.connection.SetReadDeadline(time.Now().Add(control.readTimeout))
	}
	return control.connection.ReadJSON(message)
}

// reconnectBackoff spaces control reconnect attempts with exponential growth
// and jitter so a restarting Factory is not hit by every Runtime at once.
type reconnectBackoff struct{ attempt int }

func (backoff *reconnectBackoff) next() time.Duration {
	delay := controlReconnectMin
	for step := 0; step < backoff.attempt && delay < controlReconnectMax; step++ {
		delay *= 2
	}
	delay = min(delay, controlReconnectMax)
	backoff.attempt++
	return delay + time.Duration(rand.Int64N(int64(delay/2)+1))
}

func (backoff *reconnectBackoff) reset() { backoff.attempt = 0 }

func (control *controlConnection) write(message Message) error {
	control.writeLock.Lock()
	defer control.writeLock.Unlock()
	if err := control.connection.SetWriteDeadline(time.Now().Add(controlWriteTimeout)); err != nil {
		return err
	}
	return control.connection.WriteJSON(message)
}

func (control *controlConnection) close() error {
	var err error
	control.closeOnce.Do(func() {
		close(control.done)
		err = control.connection.Close()
	})
	return err
}

func (control *controlConnection) keepAlive(ctx context.Context) {
	ticker := time.NewTicker(controlPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-control.done:
			return
		case <-ticker.C:
			if err := control.connection.WriteControl(
				websocket.PingMessage,
				nil,
				time.Now().Add(controlWriteTimeout),
			); err != nil {
				control.close()
				return
			}
		}
	}
}
