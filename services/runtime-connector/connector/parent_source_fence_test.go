package connector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestParentSourceFenceDrainsConcurrentWritersAndRejectsLateOperations(t *testing.T) {
	var fence parentSourceFence
	entered, release, drained := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var writes atomic.Int32
	handle := fence.wrap(func(_ context.Context, message Message) Message {
		if message.Action == "browser-call" {
			close(entered)
			<-release
			writes.Add(1)
		} else if message.Action == "source-drain" {
			close(drained)
		} else {
			writes.Add(1)
		}
		return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	})
	ctx := context.Background()
	writerDone := make(chan struct{})
	go func() {
		handle(ctx, Message{Action: "browser-call", OperationID: "in-flight"})
		close(writerDone)
	}()
	<-entered
	drainDone := make(chan Message, 1)
	go func() { drainDone <- handle(ctx, Message{Action: "source-drain", OperationID: "checkpoint-a"}) }()
	select {
	case <-drained:
		t.Fatal("Source drain raced a still-running browser operation")
	default:
	}
	close(release)
	<-writerDone
	select {
	case reply := <-drainDone:
		if reply.Error != "" || writes.Load() != 1 {
			t.Fatal("Source drain did not settle the earlier writer")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Source drain did not finish after its writer settled")
	}
	for _, action := range []string{"workspace-git", "git-prepare-commit", "git-push", "skills-install", "browser-call", "browser-renew", "browser-recording-start"} {
		if reply := handle(ctx, Message{Action: action, OperationID: "late"}); reply.Error == "" {
			t.Fatalf("late %s bypassed the Source writer fence", action)
		}
	}
	if writes.Load() != 1 {
		t.Fatal("a late operation reached the writer after drain")
	}
}

func TestParentSourceFenceRetainsCheckpointAfterFailedOrLostDrainReply(t *testing.T) {
	var fence parentSourceFence
	var calls int
	handle := fence.wrap(func(_ context.Context, message Message) Message {
		calls++
		return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "owned drain failure"}
	})
	ctx := context.Background()
	if reply := handle(ctx, Message{Action: "source-drain"}); reply.Error == "" || calls != 0 {
		t.Fatal("a drain without checkpoint identity was admitted")
	}
	for range 2 {
		handle(ctx, Message{Action: "source-drain", OperationID: "checkpoint-a"})
	}
	if calls != 2 {
		t.Fatal("the same recorded drain could not be reconciled")
	}
	for _, message := range []Message{{Action: "source-drain", OperationID: "checkpoint-b"}, {Action: "workspace-git", OperationID: "late"}} {
		if reply := handle(ctx, message); reply.Error != "Source writers are fenced for the recorded checkpoint" {
			t.Fatal("a failed drain lost its original writer fence")
		}
	}
	if calls != 2 {
		t.Fatal("a different operation was dispatched after the uncertain drain")
	}
}

func TestParentControlKeepsGitAndBrowserFencedAfterSourceDrain(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeSource = http.NotFoundHandler()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	replies := make(chan Message, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for _, message := range []Message{
			{Type: "operation-request", Action: "source-drain", OperationID: "checkpoint-a"},
			{Type: "operation-request", Action: "workspace-git", OperationID: "late-git"},
			{Type: "operation-request", Action: "browser-call", OperationID: "late-browser"},
		} {
			if connection.WriteJSON(message) != nil {
				return
			}
			var reply Message
			if connection.ReadJSON(&reply) != nil {
				return
			}
			replies <- reply
		}
		if connection.WriteJSON(Message{Type: "stop"}) != nil {
			return
		}
		var stopped Message
		if connection.ReadJSON(&stopped) == nil {
			replies <- stopped
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	control, err := dialControl(ctx, assignment, "parent", "owned-test-capability")
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	var dispatched atomic.Int32
	err = serveParentControl(ctx, assignment, "owned-test-capability", &control, nil, func(_ context.Context, message Message) Message {
		dispatched.Add(1)
		return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	})
	if err != nil || dispatched.Load() != 1 {
		t.Fatalf("Parent dispatched a writer after Source drain: calls=%d, error=%v", dispatched.Load(), err)
	}
	for index := range 3 {
		select {
		case reply := <-replies:
			if (reply.Error != "") != (index != 0) {
				t.Fatalf("Parent control did not retain the Source fence: %#v", reply)
			}
		case <-ctx.Done():
			t.Fatal("Parent control did not settle Source drain and late-writer replies")
		}
	}
}
