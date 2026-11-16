package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestParentStartupControlReconnectsBeforeBlockedPreparationReturns(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	assignment := validAssignment()
	const actorUID = "owned-startup-actor"
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", actorUID)
	const token = "owned-startup-control-capability"
	var reads, preparations, connections atomic.Int32
	assignment.nativeSource = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if r.Header.Get("X-Factory-Writer-Epoch") != "7" {
			t.Error("startup Source lost its authenticated writer epoch")
		}
		_, _ = io.WriteString(w, "owned Source while starting")
	})
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	peers := make(chan *websocket.Conn, 4)
	var handlers sync.WaitGroup
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		if connections.Add(1) > 2 {
			t.Error("startup replayed a completed transport handshake")
			http.Error(w, "unexpected reconnect", http.StatusForbidden)
			return
		}
		for header, want := range map[string]string{
			"Authorization":                "Bearer " + token,
			"X-Factory-Runtime-Attempt":    assignment.RuntimeAttemptID,
			"X-Factory-Runtime-Generation": strconv.FormatUint(assignment.Generation, 10),
			"X-Factory-Runtime-Actor-UID":  actorUID,
			"X-Factory-Connector-Role":     "parent",
			"Sec-WebSocket-Protocol":       ConnectorProtocol,
		} {
			if r.Header.Get(header) != want {
				t.Errorf("startup reconnect changed %s", header)
				http.Error(w, "changed admitted authority", http.StatusForbidden)
				return
			}
		}
		peer, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		select {
		case peers <- peer:
		case <-ctx.Done():
			return
		}
		<-ctx.Done()
	}))
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	var control, original *controlConnection
	finished := make(chan struct{})
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	var prepareErr error
	serving := false
	t.Cleanup(func() {
		cancel()
		releaseOnce.Do(func() { close(release) })
		if serving {
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Error("owned startup preparation did not join")
				return
			}
		}
		for _, connection := range []*controlConnection{original, control} {
			if connection != nil {
				connection.close()
				if connection.readerDone != nil {
					select {
					case <-connection.readerDone:
					case <-time.After(time.Second):
						t.Error("startup control reader did not join")
					}
				}
			}
		}
		server.Close()
		handlers.Wait()
	})
	nextPeer := func() *websocket.Conn {
		t.Helper()
		select {
		case peer := <-peers:
			return peer
		case <-ctx.Done():
			t.Fatal("no second authenticated hello + status starting while preparation remained blocked")
		}
		return nil
	}
	read := func(peer *websocket.Conn) Message {
		t.Helper()
		deadline, _ := ctx.Deadline()
		_ = peer.SetReadDeadline(deadline)
		var message Message
		if err := peer.ReadJSON(&message); err != nil {
			t.Fatalf("read startup control: %v", err)
		}
		return message
	}
	write := func(peer *websocket.Conn, message Message) {
		t.Helper()
		deadline, _ := ctx.Deadline()
		_ = peer.SetWriteDeadline(deadline)
		if err := peer.WriteJSON(message); err != nil {
			t.Fatal(err)
		}
	}
	hello := Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID,
		Generation: assignment.Generation, Channels: parentChannels(assignment)}
	checkStarting := func(peer *websocket.Conn) {
		t.Helper()
		if got := read(peer); !reflect.DeepEqual(got, hello) {
			t.Fatalf("startup hello changed exact identity/Source channels: %#v", got)
		}
		if got := read(peer); got.Type != "status" || got.Phase != "starting" {
			t.Fatalf("incomplete startup claimed another phase: %#v", got)
		}
	}
	checkSource := func(peer *websocket.Conn, stream string) {
		t.Helper()
		write(peer, Message{Type: "http-request", StreamID: stream, Channel: "source", Method: "GET",
			Path: "/v1/workspaces/owned/tree", Headers: map[string]string{"x-factory-writer-epoch": "7"}})
		var body strings.Builder
		for {
			message := read(peer)
			if message.Type == "stream-data" {
				data, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					t.Fatal(err)
				}
				body.Write(data)
			} else if message.Type == "stream-end" {
				break
			} else if message.Type != "http-response" {
				t.Fatalf("startup dispatched a writer or claimed readiness: %#v", message)
			}
		}
		if body.String() != "owned Source while starting" {
			t.Fatal("starting Parent did not serve its original Source")
		}
	}
	var err error
	control, err = dialControl(ctx, assignment, "parent", token)
	if err != nil {
		t.Fatal(err)
	}
	original = control
	if err := control.write(hello); err != nil {
		t.Fatal(err)
	}
	if err := control.write(Message{Type: "status", Phase: "starting"}); err != nil {
		t.Fatal(err)
	}
	first := nextPeer()
	checkStarting(first)
	serving = true
	go func() {
		defer close(finished)
		prepareErr = withParentStartupControl(ctx, assignment, token, &control, func(ctx context.Context) error {
			preparations.Add(1)
			close(started)
			select {
			case <-release:
				return errors.New("original preparation result")
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	<-started
	write(first, Message{Type: "operation-request", Action: "workspace-git", OperationID: "old-startup-writer"})
	checkSource(first, "old-source")
	first.Close()
	select {
	case <-original.done:
	case <-ctx.Done():
		t.Fatal("owned first transport loss was not detected")
	}
	second := nextPeer()
	checkStarting(second)
	write(second, Message{Type: "operation-request", Action: "workspace-git", OperationID: "new-startup-writer"})
	checkSource(second, "new-source")
	select {
	case <-finished:
		t.Fatal("control loss cancelled or restarted the still-blocked preparation")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("original preparation did not finish")
	}
	if prepareErr == nil || prepareErr.Error() != "original preparation result" ||
		preparations.Load() != 1 || connections.Load() != 2 || reads.Load() != 2 {
		t.Fatalf("startup replayed work or lost its result: %v preparations=%d connections=%d reads=%d",
			prepareErr, preparations.Load(), connections.Load(), reads.Load())
	}
	for _, pending := range []struct {
		connection *controlConnection
		id         string
	}{{original, "old-startup-writer"}, {control, "new-startup-writer"}} {
		if cap(pending.connection.incoming) != controlReadQueueLimit || len(pending.connection.incoming) == 0 {
			t.Fatal("startup consumed a pending writer or changed the transport queue bound")
		}
		var message Message
		if err := pending.connection.read(&message); err != nil || message.OperationID != pending.id {
			t.Fatalf("startup changed a queued writer: %#v %v", message, err)
		}
	}
}

func TestParentStartupControlCancellationJoinsPreparationWithFullQueue(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	started, cleaning, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	sent, peerDone, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	var preparations atomic.Int32
	var prepareErr error
	assignment := validAssignment()
	const token = "owned-startup-control-capability"
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(peerDone)
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unadmitted Parent", http.StatusForbidden)
			return
		}
		peer, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer peer.Close()
		for _, kind := range []string{"hello", "status"} {
			var message Message
			if err := peer.ReadJSON(&message); err != nil {
				t.Error(err)
				return
			}
			if message.Type != kind || (kind == "status" && message.Phase != "starting") {
				t.Errorf("unexpected startup report: %#v", message)
				return
			}
		}
		select {
		case <-started:
		case <-ctx.Done():
			return
		}
		// Leave Stop and writers with their existing owners. More than eight
		// application frames can block the reader before it consumes an EOF;
		// startup must not drain them into an unbounded queue or dispatch them.
		for index := range controlReadQueueLimit + 1 {
			message := Message{Type: "operation-request", Action: "workspace-git", OperationID: strconv.Itoa(index)}
			if index == 0 {
				message = Message{Type: "stop"}
			}
			if err := peer.WriteJSON(message); err != nil {
				return
			}
		}
		close(sent)
		for {
			var message Message
			if peer.ReadJSON(&message) != nil {
				return
			}
			t.Errorf("startup dispatched a queued operation or claimed readiness: %#v", message)
		}
	}))
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	var control *controlConnection
	serving := false
	t.Cleanup(func() {
		cancel()
		releaseOnce.Do(func() { close(release) })
		if control != nil {
			control.close()
		}
		if serving {
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Error("owned startup preparation did not join")
			}
		}
		if control != nil && control.readerDone != nil {
			select {
			case <-control.readerDone:
			case <-time.After(time.Second):
				t.Error("blocked startup reader did not join")
			}
		}
		server.Close()
		if control != nil {
			select {
			case <-peerDone:
			case <-time.After(time.Second):
				t.Error("owned startup peer did not join")
			}
		}
	})
	var err error
	control, err = dialControl(ctx, assignment, "parent", token)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range []Message{
		{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation},
		{Type: "status", Phase: "starting"},
	} {
		if err := control.write(message); err != nil {
			t.Fatal(err)
		}
	}
	serving = true
	go func() {
		defer close(finished)
		prepareErr = withParentStartupControl(ctx, assignment, token, &control, func(ctx context.Context) error {
			preparations.Add(1)
			close(started)
			<-ctx.Done()
			close(cleaning)
			<-release
			return ctx.Err()
		})
	}()
	select {
	case <-sent:
	case <-ctx.Done():
		t.Fatal("fixture did not send its bounded application burst")
	}
	until := time.Now().Add(time.Second)
	for len(control.incoming) != controlReadQueueLimit && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	if cap(control.incoming) != controlReadQueueLimit || len(control.incoming) != controlReadQueueLimit {
		t.Fatal("startup changed or consumed the bounded application queue")
	}
	cancel()
	select {
	case <-cleaning:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not reach the original preparation")
	}
	select {
	case <-control.readerDone:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not release the full transport queue")
	}
	select {
	case <-finished:
		t.Fatal("startup returned before owned preparation cleanup finished")
	case <-time.After(25 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("startup did not join completed preparation cleanup")
	}
	if !errors.Is(prepareErr, context.Canceled) || preparations.Load() != 1 {
		t.Fatalf("cancellation replayed preparation or lost cancellation: %v preparations=%d", prepareErr, preparations.Load())
	}
}

func TestParentStartupControlDoesNotStartCancelledPreparation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var control *controlConnection
	err := withParentStartupControl(ctx, validAssignment(), "unused", &control, func(context.Context) error {
		t.Error("cancelled startup invoked preparation")
		return nil
	})
	if !errors.Is(err, context.Canceled) || control != nil {
		t.Fatalf("cancelled startup changed control or lost cancellation: %v", err)
	}
}

func TestParentStartupControlKeepsSuccessfulPreparationContextAlive(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	control := &controlConnection{done: make(chan struct{})}
	var preparedContext context.Context
	err := withParentStartupControl(ctx, validAssignment(), "unused", &control, func(ctx context.Context) error {
		preparedContext = ctx
		return nil
	})
	if err != nil || preparedContext.Err() != nil {
		t.Fatalf("successful startup cancelled the context owning its Child: %v", err)
	}
	cancel()
	select {
	case <-preparedContext.Done():
	default:
		t.Fatal("prepared Child context no longer follows Parent cancellation")
	}
}
