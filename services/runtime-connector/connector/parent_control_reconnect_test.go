package connector

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestParentControlReconnectReconcilesSourceDrain(t *testing.T) {
	for _, scenario := range []struct {
		name            string
		browserInFlight bool
	}{
		{name: "lost-drain-acknowledgement"},
		{name: "in-flight-browser-cleanup", browserInFlight: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			manager, scope := browserRuntimeFixture(t)
			assignment := manager.assignment
			assignment.nativeSource = http.NotFoundHandler()
			manager.ctx = ctx

			firstDrain := make(chan struct{})
			releaseDrain := make(chan struct{})
			cleanupStarted := make(chan struct{})
			releaseCleanup := make(chan struct{})
			var drainRelease, cleanupRelease, cleanupStart sync.Once
			input := browserRecordingInput{started: make(chan struct{}, 1)}
			var runtime *browserRuntime
			if scenario.browserInFlight {
				live, end := context.WithCancel(ctx)
				// Reuse the existing browser RPC seam. No command is started,
				// and no MCP reply arrives before disconnect cancels the call.
				runtime = &browserRuntime{
					scope: scope, directory: manager.directory(scope.SessionID),
					ctx: live, cancel: end, command: &exec.Cmd{}, input: input,
					responses: make(chan browserMCPReply, 1),
				}
				manager.sessions[scope.SessionID] = runtime
			}
			browserName, proxyName := browserRuntimeNames(scope.SessionID)
			manager.docker = func(_ context.Context, args ...string) ([]byte, error) {
				// Only absence observations for this fixture's exact resources
				// are allowed. Never invoke Docker or a real browser.
				if !scenario.browserInFlight || len(args) != 4 ||
					!reflect.DeepEqual(args[:3], []string{"ps", "-aq", "--filter"}) ||
					(args[3] != "name=^/"+browserName+"$" &&
						args[3] != "name=^/"+proxyName+"$" &&
						args[3] != "id="+manager.primaryID) {
					t.Errorf("unexpected browser cleanup command: %q", args)
					return nil, errors.New("unexpected fixture cleanup command")
				}
				if runtime.ctx.Err() == nil {
					t.Error("browser cleanup started without cancelling its in-flight call")
				}
				cleanupStart.Do(func() { close(cleanupStarted) })
				select {
				case <-releaseCleanup:
					return nil, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}

			const token = "owned-parent-reconnect-capability"
			var requests atomic.Int32
			var handlers sync.WaitGroup
			peers := make(chan *websocket.Conn, 4)
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				handlers.Add(1)
				defer handlers.Done()
				if requests.Add(1) > 2 {
					t.Error("Parent opened more than the original and replacement control sockets")
					http.Error(w, "unexpected reconnect", http.StatusForbidden)
					return
				}
				for header, want := range map[string]string{
					"Authorization":                "Bearer " + token,
					"X-Factory-Runtime-Attempt":    assignment.RuntimeAttemptID,
					"X-Factory-Runtime-Generation": strconv.FormatUint(assignment.Generation, 10),
					"X-Factory-Connector-Role":     "parent",
					"Sec-WebSocket-Protocol":       ConnectorProtocol,
				} {
					if r.Header.Get(header) != want {
						t.Errorf("control handshake changed %s", header)
						http.Error(w, "changed admitted authority", http.StatusForbidden)
						return
					}
				}
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Errorf("control upgrade: %v", err)
					return
				}
				defer connection.Close()
				select {
				case peers <- connection:
				case <-ctx.Done():
					return
				}
				<-ctx.Done()
			}))
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			manager.assignment = assignment

			var control, original *controlConnection
			finished := make(chan struct{})
			var serveErr error
			serving := false
			t.Cleanup(func() {
				drainRelease.Do(func() { close(releaseDrain) })
				cleanupRelease.Do(func() { close(releaseCleanup) })
				cancel()
				server.Close()
				handlers.Wait()
				if serving {
					select {
					case <-finished:
					case <-time.After(2 * time.Second):
						t.Error("Parent control did not stop after fixture cancellation")
						return
					}
				}
				for _, connection := range []*controlConnection{original, control} {
					if connection != nil {
						_ = connection.close()
						if connection.readerDone != nil {
							select {
							case <-connection.readerDone:
							case <-time.After(time.Second):
								t.Error("owned control reader did not stop")
							}
						}
					}
				}
				if err := manager.closeAll(); err != nil {
					t.Errorf("fixture browser cleanup: %v", err)
				}
			})
			wait := func(signal <-chan struct{}, stage string) {
				t.Helper()
				select {
				case <-signal:
				case <-finished:
					select {
					case <-signal:
						return
					default:
					}
					t.Fatalf("%s: Parent control exited: %v", stage, serveErr)
				case <-ctx.Done():
					t.Fatalf("%s: %v", stage, ctx.Err())
				}
			}
			nextPeer := func() *websocket.Conn {
				t.Helper()
				select {
				case peer := <-peers:
					return peer
				case <-finished:
					t.Fatalf("control reconnect exited: %v", serveErr)
				case <-ctx.Done():
					t.Fatalf("control reconnect did not complete: %v", ctx.Err())
				}
				return nil
			}
			deadline, _ := ctx.Deadline()
			write := func(peer *websocket.Conn, message Message) {
				t.Helper()
				if err := peer.SetWriteDeadline(deadline); err != nil {
					t.Fatal(err)
				}
				if err := peer.WriteJSON(message); err != nil {
					t.Fatalf("send %s/%s: %v", message.Type, message.OperationID, err)
				}
			}
			read := func(peer *websocket.Conn) Message {
				t.Helper()
				if err := peer.SetReadDeadline(deadline); err != nil {
					t.Fatal(err)
				}
				var message Message
				if err := peer.ReadJSON(&message); err != nil {
					t.Fatalf("receive Parent control frame: %v", err)
				}
				return message
			}
			hello := Message{
				Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID,
				Generation: assignment.Generation, Channels: parentChannels(assignment),
			}
			checkStarted := func(peer *websocket.Conn) {
				t.Helper()
				if got := read(peer); !reflect.DeepEqual(got, hello) {
					t.Fatalf("Parent hello changed admitted identity or Source channel: %#v", got)
				}
				if got := read(peer); got.Type != "status" || got.Phase != "child-started" || got.Error != "" {
					t.Fatalf("Parent did not restore child readiness: %#v", got)
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
			if err := announceChildStarted(ctx, assignment, token, &control); err != nil {
				t.Fatal(err)
			}
			first := nextPeer()
			checkStarted(first)
			checkpoint := Message{
				Type: "operation-request", Action: "source-drain", OperationID: "original-checkpoint",
				AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation,
			}
			dispatched := make(chan Message, 8)
			var drainCalls atomic.Int32
			handle := func(operationContext context.Context, message Message) Message {
				dispatched <- message
				response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
				if message.Action == "source-drain" {
					call := drainCalls.Add(1)
					// Distinguish the retry's acknowledgement from the lost
					// reply, even though both have the same checkpoint ID.
					response.Data = "drain-dispatch-" + strconv.FormatInt(int64(call), 10)
					if call == 1 {
						if runtime != nil && runtime.ctx.Err() == nil {
							t.Error("Source drain overtook the in-flight browser writer")
						}
						close(firstDrain)
						select {
						case <-releaseDrain:
						case <-operationContext.Done():
						}
					}
				}
				return response
			}
			serving = true
			go func() {
				// Exercise the real read loop, shared Source fence, operation
				// worker, browser cleanup and authenticated reconnect together.
				serveErr = serveParentControl(ctx, assignment, token, &control, manager, handle)
				close(finished)
			}()
			if scenario.browserInFlight {
				call := browserScopeMessage(manager, scope, "browser-call")
				call.Type, call.OperationID = "operation-request", "in-flight-browser"
				write(first, call)
				wait(input.started, "browser RPC dispatch")
			}
			write(first, checkpoint)
			if !scenario.browserInFlight {
				wait(firstDrain, "original Source drain dispatch")
			}
			// This queued writer also survives socket loss, but must never
			// reach the injected operation handler after the Source checkpoint.
			write(first, Message{Type: "operation-request", Action: "workspace-git", OperationID: "late-original-writer"})
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}
			if scenario.browserInFlight {
				wait(cleanupStarted, "disconnect browser cancellation and cleanup")
				wait(firstDrain, "Source drain after in-flight browser cancellation")
				if requests.Load() != 1 {
					t.Fatal("Parent reconnected before its browser cleanup completed")
				}
				cleanupRelease.Do(func() { close(releaseCleanup) })
			}
			second := nextPeer()
			if second == first {
				t.Fatal("fixture reused its original socket")
			}
			checkStarted(second)
			if runtime != nil {
				runtime.mu.Lock()
				closed, sequence := runtime.closed, runtime.sequence
				runtime.mu.Unlock()
				manager.mu.Lock()
				remaining := len(manager.sessions)
				manager.mu.Unlock()
				if !closed || runtime.ctx.Err() == nil || remaining != 0 || sequence != 1 {
					t.Fatalf("reconnect did not settle the original browser exactly once: closed=%v sessions=%d calls=%d", closed, remaining, sequence)
				}
				if _, err := os.Stat(filepath.Join(runtime.directory, "ended")); err != nil {
					t.Fatalf("browser cleanup outcome was not recorded: %v", err)
				}
			}

			lateBrowser := browserScopeMessage(manager, scope, "browser-call")
			lateBrowser.Type, lateBrowser.OperationID = "operation-request", "late-browser"
			different := checkpoint
			different.OperationID = "different-checkpoint"
			lateGit := Message{Type: "operation-request", Action: "workspace-git", OperationID: "late-reconnected-writer"}
			// Probe the retained fence before replaying the recorded checkpoint,
			// so a retry cannot conceal authority accidentally reset by reconnect.
			for _, message := range []Message{lateGit, different, lateBrowser, checkpoint} {
				write(second, message)
			}
			// The first operation completes only after the new hello/readiness.
			// Its acknowledgement goes to the dead socket captured by the worker.
			drainRelease.Do(func() { close(releaseDrain) })
			expected := map[string]Message{
				lateGit.OperationID: lateGit, different.OperationID: different,
				lateBrowser.OperationID: lateBrowser, checkpoint.OperationID: checkpoint,
			}
			for len(expected) != 0 {
				reply := read(second)
				request, ok := expected[reply.OperationID]
				if !ok || reply.Type != "operation-response" || reply.Action != request.Action {
					t.Fatalf("new socket received a stale or unrelated acknowledgement: %#v", reply)
				}
				wantError := "Source writers are fenced for the recorded checkpoint"
				wantData := ""
				if reply.OperationID == checkpoint.OperationID {
					wantError = ""
					wantData = "drain-dispatch-2"
				}
				if reply.Error != wantError || reply.Data != wantData {
					t.Fatalf("reconnected %s/%s: error=%q data=%q, want error=%q data=%q", reply.Action, reply.OperationID, reply.Error, reply.Data, wantError, wantData)
				}
				delete(expected, reply.OperationID)
			}
			write(second, Message{Type: "stop"})
			if got := read(second); got.Type != "status" || got.Phase != "stopping" {
				t.Fatalf("replacement control socket did not remain usable: %#v", got)
			}
			wait(finished, "Parent Stop")
			if serveErr != nil {
				t.Fatal(serveErr)
			}
			close(dispatched)
			var operations []Message
			for message := range dispatched {
				operations = append(operations, message)
			}
			if !reflect.DeepEqual(operations, []Message{checkpoint, checkpoint}) || drainCalls.Load() != 2 || requests.Load() != 2 {
				t.Fatalf("reconnect replayed a writer or changed checkpoint dispatch: operations=%#v drainCalls=%d connections=%d", operations, drainCalls.Load(), requests.Load())
			}
			t.Log("same Attempt/Generation and Parent token; original drain reply lost; identical checkpoint acknowledged on socket 2; old/new writers and different checkpoint fenced")
		})
	}
}
