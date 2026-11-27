package connector

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type blockedLanguageInput struct {
	pipe      *io.PipeWriter
	started   chan struct{}
	closed    chan struct{}
	writeOnce sync.Once
	closeOnce sync.Once
}

func (input *blockedLanguageInput) Write(value []byte) (int, error) {
	input.writeOnce.Do(func() { close(input.started) })
	return input.pipe.Write(value)
}
func (input *blockedLanguageInput) Close() error {
	input.closeOnce.Do(func() { close(input.closed) })
	return input.pipe.Close()
}

func TestLanguageBackpressureCannotBlockControlClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connections := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			connections <- connection
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	controlPeer := <-connections
	defer controlPeer.Close()
	reader, writer := io.Pipe()
	defer reader.Close()
	input := &blockedLanguageInput{pipe: writer, started: make(chan struct{}), closed: make(chan struct{})}
	manager := newLanguageManager(ctx, validAssignment(), func(Message) error { return nil })
	manager.RegisterSession("owned-language", "workspace-a", "/workspace", exec.Command("unused"), input)
	defer manager.CloseAll()
	runtime := &childRuntime{languages: manager}
	finished := make(chan error, 1)
	go func() {
		finished <- runtime.readLoop(ctx, newControlConnection(client))
	}()
	defer func() { client.Close(); <-finished }()
	body := `{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"factory-workspace://workspace-a/main.ts","languageId":"typescript","version":1,"text":"const n = 1;"}}}`
	if err := controlPeer.WriteJSON(Message{Type: "websocket-message", StreamID: "owned-language", MessageType: 1, Data: base64.StdEncoding.EncodeToString([]byte(body))}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-input.started:
	case <-time.After(time.Second):
		t.Fatal("language write did not reach the real blocked pipe")
	}
	if err := controlPeer.WriteJSON(Message{Type: "stream-close", StreamID: "owned-language"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-input.closed:
	case <-time.After(time.Second):
		// Unblock the red-case reader before its test cleanup waits on it.
		manager.Close("owned-language")
		t.Fatal("language stdin backpressure blocked the control stream-close")
	}
}
