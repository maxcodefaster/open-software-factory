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
	session := &languageSession{command: exec.Command("unused"), input: input, scope: languageURIs{"workspace-a", "/workspace"}, writes: make(chan any, 16), done: make(chan struct{})}
	manager.sessions["owned-language"] = session
	defer manager.closeAll()
	manager.readers.Add(1)
	go func() { defer manager.readers.Done(); manager.writeLoop("owned-language", session) }()
	runtime := &childRuntime{languages: manager}
	finished := make(chan error, 1)
	go func() { finished <- runtime.readLoop(ctx, &controlConnection{connection: client}) }()
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
		manager.close("owned-language")
		t.Fatal("language stdin backpressure blocked the control stream-close")
	}
}

func TestLanguageInputQueueIsOrderedBoundedAndFencedAfterClose(t *testing.T) {
	session := &languageSession{writes: make(chan any, 16), done: make(chan struct{})}
	for index := 0; index < cap(session.writes); index++ {
		if err := session.write(index); err != nil {
			t.Fatal(err)
		}
	}
	if session.write("overflow") == nil {
		t.Fatal("unbounded language queue")
	}
	close(session.done)
	if session.write("after close") == nil {
		t.Fatal("closed session admitted another input")
	}
	for index := 0; index < cap(session.writes); index++ {
		if value := <-session.writes; value != index {
			t.Fatalf("language input reordered: %v != %d", value, index)
		}
	}
}
