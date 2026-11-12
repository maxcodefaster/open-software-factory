package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

var sourceRequestNumber atomic.Uint64

func parentSourceFixture(t *testing.T, workspace string) (*parentSourceStreams, *controlConnection, <-chan Message, string) {
	t.Helper()
	root := t.TempDir()
	source, err := workspacefiles.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { source.Close() })
	access := workspacefiles.Access{WorkspaceID: workspace, ServiceID: "source-" + workspace, Epoch: 1, WriterEpoch: 1, Token: strings.Repeat("a", 32)}
	service, err := workspacefiles.NewService(source, access)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Revoke)
	streams := &parentSourceStreams{handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+access.Token)
		request.Header.Set("X-Factory-Source-Service", access.ServiceID)
		request.Header.Set("X-Factory-Source-Epoch", "1")
		service.ServeHTTP(response, request)
	})}
	messages := make(chan Message, 128)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connection, err := upgrader.Upgrade(response, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			var message Message
			if connection.ReadJSON(&message) != nil {
				return
			}
			messages <- message
		}
	}))
	t.Cleanup(server.Close)
	assignment := validAssignment()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	control, err := dialControl(context.Background(), assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { control.close() })
	return streams, control, messages, root
}

func sourceMessage(t *testing.T, workspace, operation, epoch string, body any) Message {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return Message{Type: "http-request", StreamID: fmt.Sprintf("owned-%d", sourceRequestNumber.Add(1)), Channel: "source", Method: http.MethodPost,
		Path:    "/v1/workspaces/" + workspace + "/" + operation,
		Headers: map[string]string{"x-factory-writer-epoch": epoch}, Data: base64.StdEncoding.EncodeToString(encoded)}
}

func sourceReply(t *testing.T, messages <-chan Message) (int, []byte) {
	t.Helper()
	status := 0
	var body []byte
	for {
		select {
		case message := <-messages:
			switch message.Type {
			case "http-response":
				status = message.Status
			case "stream-data":
				part, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					t.Fatal(err)
				}
				body = append(body, part...)
			case "stream-end", "stream-error":
				return status, body
			}
		case <-time.After(3 * time.Second):
			t.Fatal("Source did not settle on its Parent connection")
		}
	}
}

func TestParentSourceControlUsesCanonicalTreeFencesCASAndPathBoundaries(t *testing.T) {
	streams, control, messages, root := parentSourceFixture(t, "workspace-a")
	call := func(workspace, operation, epoch string, body any, expected int) []byte {
		t.Helper()
		streams.start(context.Background(), control, sourceMessage(t, workspace, operation, epoch, body))
		status, result := sourceReply(t, messages)
		if status != expected {
			t.Fatalf("%s: status %d, expected %d", operation, status, expected)
		}
		return result
	}
	create := map[string]any{"path": "private.txt", "content": []byte("owned-private")}
	first := call("workspace-a", "write", "1", create, 200)
	// Retrying a save whose reply was lost observes the same bytes/CAS version.
	if string(call("workspace-a", "write", "1", create, 200)) != string(first) {
		t.Fatal("lost save reply created a different result")
	}
	for _, epoch := range []string{"", "0", "2"} {
		call("workspace-a", "write", epoch, map[string]any{"path": "private.txt", "content": []byte("stale")}, 409)
	}
	call("workspace-a", "write", "1", map[string]any{"path": "private.txt", "content": []byte("blind")}, 409)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("outside-private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "symlink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "hardlink")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside", ".git/config", "symlink", "hardlink", "/etc/passwd"} {
		call("workspace-a", "read", "", map[string]string{"path": path}, 403)
	}
	denied := call("workspace-b", "read", "", map[string]string{"path": "private.txt"}, 404)
	if strings.Contains(string(denied), "owned-private") {
		t.Fatal("cross-Workspace denial leaked Source")
	}
	current, err := os.ReadFile(filepath.Join(root, "private.txt"))
	if err != nil || string(current) != "owned-private" {
		t.Fatal("canonical tree was not preserved")
	}
	search := call("workspace-a", "search", "", map[string]any{"search": map[string]any{"query": "owned-private"}}, 200)
	if !strings.Contains(string(search), "private.txt") {
		t.Fatal("search did not inspect canonical Source")
	}
}

func TestParentSourceWatchAndCancellationStayOnTheirOriginalConnection(t *testing.T) {
	streams, control, messages, root := parentSourceFixture(t, "workspace-a")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	streams.start(ctx, control, Message{Type: "http-request", StreamID: "watch", Channel: "source", Method: "GET", Path: "/v1/workspaces/workspace-a/events"})
	select {
	case message := <-messages:
		if message.Type != "http-response" || message.Status != 200 {
			t.Fatal("watch did not return authenticated headers")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watch did not open")
	}
	if err := os.WriteFile(filepath.Join(root, "atomic.tmp"), []byte("watch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "atomic.tmp"), filepath.Join(root, "atomic.txt")); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case message := <-messages:
			data, _ := base64.StdEncoding.DecodeString(message.Data)
			if strings.Contains(string(data), "atomic.txt") {
				streams.close("watch")
				for {
					select {
					case ended := <-messages:
						if ended.Type == "stream-end" {
							return
						}
					case <-deadline:
						t.Fatal("closed Source watch retained its stream")
					}
				}
			}
		case <-deadline:
			t.Fatal("Source watch did not observe atomic save")
		}
	}
}

func TestParentSourceRejectsProxyTargetsAndUndeclaredChannels(t *testing.T) {
	streams, control, messages, _ := parentSourceFixture(t, "workspace-a")
	for _, change := range []func(*Message){
		func(m *Message) { m.Channel = "app" },
		func(m *Message) { m.Path = "http://outside.invalid/v1/workspaces/workspace-a/read" },
		func(m *Message) { m.Path += "?token=forged" },
		func(m *Message) { m.Method = "CONNECT" },
		func(m *Message) { m.Data = "!invalid" },
	} {
		message := sourceMessage(t, "workspace-a", "read", "", map[string]string{"path": "private.txt"})
		change(&message)
		streams.start(context.Background(), control, message)
		status, _ := sourceReply(t, messages)
		if status != 0 {
			t.Fatal("unsupported Parent proxy target reached Source")
		}
	}
	if fmt.Sprint(parentChannels(Assignment{})) != "[]" {
		t.Fatal("Project assignment advertised native Source")
	}
}
