package connector

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type controlConnection struct {
	connection *websocket.Conn
	writeLock  sync.Mutex
	closeOnce  sync.Once
	done       chan struct{}
}

func dialControl(ctx context.Context, assignment Assignment, role string, token string) (*controlConnection, error) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+token)
	headers.Set("X-Factory-Runtime-Attempt", assignment.RuntimeAttemptID)
	headers.Set("X-Factory-Runtime-Generation", fmt.Sprint(assignment.Generation))
	headers.Set("X-Factory-Connector-Role", role)
	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
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
	go control.keepAlive(ctx)
	return control, nil
}

func (control *controlConnection) write(message Message) error {
	control.writeLock.Lock()
	defer control.writeLock.Unlock()
	if err := control.connection.SetWriteDeadline(time.Now().Add(15 * time.Second)); err != nil {
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
	ticker := time.NewTicker(30 * time.Second)
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
				time.Now().Add(15*time.Second),
			); err != nil {
				control.close()
				return
			}
		}
	}
}
