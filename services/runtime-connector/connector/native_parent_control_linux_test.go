package connector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const (
	nativeParentControlCheckpoint      = "99a711be-d5db-4c4a-9a07-40fcdfed2fba"
	nativeParentControlOtherCheckpoint = "3637c6ad-5b13-4aa3-8554-7224caf1cc4b"
	nativeParentControlFenced          = "Source writers are fenced for the recorded checkpoint"
)

// Only the Factory peer and explicitly owned Git subprocess are controlled.
// The production runNativeController owns dispatch, fencing, reconnect and Stop.
// Tests are deliberately serial: that owner binds its fixed readiness port.
type nativeParentControlFixture struct {
	t          *testing.T
	ctx        context.Context
	assignment Assignment
	source     *nativeSourceOwner
	peers      chan *websocket.Conn
	done       chan struct{}
	err        error // Read only after done closes.
	requests   atomic.Int32
}

func newNativeParentControlFixture(t *testing.T) *nativeParentControlFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	fixture := &nativeParentControlFixture{
		t: t, ctx: ctx, assignment: validAssignment(), source: &nativeSourceOwner{},
		peers: make(chan *websocket.Conn, 4), done: make(chan struct{}),
	}
	fixture.source.ready.Store(true)
	fixture.source.epoch.Store(7)
	fixture.assignment.SetNativeSource(fixture.source)
	fixture.assignment.SetNativeActorUID("10eea218-07af-4093-8d35-fb6b42ee0bed")
	const token = "owned-native-parent-control-capability"
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fixture.requests.Add(1) > 2 {
			t.Error("native Parent opened more than the original and replacement control sockets")
			http.Error(w, "unexpected reconnect", http.StatusForbidden)
			return
		}
		for header, want := range map[string]string{
			"Authorization":                "Bearer " + token,
			"X-Factory-Runtime-Attempt":    fixture.assignment.RuntimeAttemptID,
			"X-Factory-Runtime-Generation": strconv.FormatUint(fixture.assignment.Generation, 10),
			"X-Factory-Runtime-Actor-UID":  fixture.assignment.NativeActorUID(),
			"X-Factory-Connector-Role":     "parent",
			"Sec-WebSocket-Protocol":       ConnectorProtocol,
		} {
			if r.Header.Get(header) != want {
				t.Errorf("native Parent changed admitted %s on connection %d", header, fixture.requests.Load())
				http.Error(w, "changed admitted authority", http.StatusForbidden)
				return
			}
		}
		if r.URL.RequestURI() != "/runtime/connect" {
			t.Error("native Parent changed its original Factory endpoint")
			http.Error(w, "changed endpoint", http.StatusForbidden)
			return
		}
		peer, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("native control upgrade: %v", err)
			return
		}
		defer peer.Close()
		select {
		case fixture.peers <- peer:
		case <-ctx.Done():
			return
		}
		<-ctx.Done()
	}))
	fixture.assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http") + "/runtime/connect"
	t.Cleanup(func() {
		cancel()
		server.Close()
		select {
		case <-fixture.done:
		case <-time.After(2 * time.Second):
			t.Error("owned native controller did not stop and join after cancellation")
		}
	})
	go func() {
		fixture.err = runNativeController(ctx, fixture.assignment, token, fixture.source)
		close(fixture.done)
	}()
	return fixture
}

func (fixture *nativeParentControlFixture) peer() *websocket.Conn {
	fixture.t.Helper()
	select {
	case peer := <-fixture.peers:
		return peer
	case <-fixture.done:
		fixture.t.Fatalf("native controller exited before connecting: %v", fixture.err)
	case <-fixture.ctx.Done():
		fixture.t.Fatal("native controller did not connect before its fixture deadline")
	}
	return nil
}

func (fixture *nativeParentControlFixture) wait(signal <-chan struct{}, stage string) {
	fixture.t.Helper()
	select {
	case <-signal:
	case <-fixture.done:
		select {
		case <-signal:
			return
		default:
		}
		fixture.t.Fatalf("%s: native controller exited: %v", stage, fixture.err)
	case <-fixture.ctx.Done():
		fixture.t.Fatalf("%s: fixture deadline elapsed", stage)
	}
}

func (fixture *nativeParentControlFixture) write(peer *websocket.Conn, message Message) {
	fixture.t.Helper()
	deadline, _ := fixture.ctx.Deadline()
	if err := peer.SetWriteDeadline(deadline); err != nil {
		fixture.t.Fatal(err)
	}
	if err := peer.WriteJSON(message); err != nil {
		fixture.t.Fatalf("send %s/%s: %v", message.Type, message.OperationID, err)
	}
}

func (fixture *nativeParentControlFixture) read(peer *websocket.Conn) Message {
	fixture.t.Helper()
	deadline, _ := fixture.ctx.Deadline()
	if err := peer.SetReadDeadline(deadline); err != nil {
		fixture.t.Fatal(err)
	}
	var message Message
	if err := peer.ReadJSON(&message); err != nil {
		fixture.t.Fatalf("receive native Parent frame: %v", err)
	}
	return message
}

func (fixture *nativeParentControlFixture) hello(peer *websocket.Conn, sourceReady bool) {
	fixture.t.Helper()
	expected := Message{Type: "hello", Role: "parent",
		AttemptID: fixture.assignment.RuntimeAttemptID, Generation: fixture.assignment.Generation}
	if sourceReady {
		epoch := uint64(7)
		expected.Channels = []Channel{{Name: "source", Kind: "source"}}
		expected.SourceEpoch = &epoch
	}
	if got := fixture.read(peer); !reflect.DeepEqual(got, expected) {
		fixture.t.Fatalf("native hello changed identity or Source readiness: got %#v want %#v", got, expected)
	}
}

func (fixture *nativeParentControlFixture) started(peer *websocket.Conn, sourceReady bool) {
	fixture.t.Helper()
	fixture.hello(peer, sourceReady)
	if got := fixture.read(peer); !reflect.DeepEqual(got, Message{Type: "status", Phase: "child-started"}) {
		fixture.t.Fatalf("native controller did not announce readiness on its transport: %#v", got)
	}
}

func (fixture *nativeParentControlFixture) reply(peer *websocket.Conn, request Message, expectedError string) {
	fixture.t.Helper()
	expected := Message{Type: "operation-response", Action: request.Action,
		OperationID: request.OperationID, Error: expectedError}
	if got := fixture.read(peer); !reflect.DeepEqual(got, expected) {
		fixture.t.Fatalf("native operation response: got %#v want %#v", got, expected)
	}
}

func (fixture *nativeParentControlFixture) stop(peer *websocket.Conn) {
	fixture.t.Helper()
	fixture.write(peer, Message{Type: "stop"})
	if got := fixture.read(peer); !reflect.DeepEqual(got, Message{Type: "status", Phase: "stopping"}) {
		fixture.t.Fatalf("native Stop was not acknowledged: %#v", got)
	}
	fixture.wait(fixture.done, "native Stop join")
	if fixture.err != nil {
		fixture.t.Fatalf("native Stop failed: %v", fixture.err)
	}
}

func nativeParentControlDrain(id, workBarrier string) Message {
	return Message{Type: "operation-request", Action: "source-drain", OperationID: id, Data: workBarrier}
}

type nativeParentControlGit struct {
	directory string
	process   *os.Process
}

func newNativeParentControlGit(t *testing.T) *nativeParentControlGit {
	t.Helper()
	// Native Parent runs Git as UID 1000, so its owned fixture must not live
	// below Go's root-only testing directory. Never touch a real checkout.
	directory, err := os.MkdirTemp("", "factory-native-parent-control-git-")
	if err != nil {
		t.Fatal(err)
	}
	git := &nativeParentControlGit{directory: directory}
	t.Cleanup(func() {
		if git.process != nil {
			_ = git.process.Kill()
			_ = git.process.Release()
		}
		if err := os.RemoveAll(directory); err != nil {
			t.Error(err)
		}
	})
	if os.Geteuid() == 0 {
		if err := os.Chown(directory, 1000, 1000); err != nil {
			t.Fatal(err)
		}
	}
	// Exec, rather than spawn, the blocking process: cancellation and cleanup
	// own one exact PID, with no descendants or inherited pipes left behind.
	script := "#!/bin/sh\ndirectory=${0%/*}\nprintf 'call\\n' >> \"$directory/calls\"\nprintf '%s' \"$$\" > \"$directory/entered\"\nexec /bin/sleep 60\n"
	if err := os.WriteFile(filepath.Join(directory, "git"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	return git
}

func (git *nativeParentControlGit) wait(fixture *nativeParentControlFixture) {
	fixture.t.Helper()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		data, err := os.ReadFile(filepath.Join(git.directory, "entered"))
		if pid, parseErr := strconv.Atoi(string(data)); err == nil && parseErr == nil && pid > 0 {
			git.process, err = os.FindProcess(pid)
			if err != nil {
				fixture.t.Fatal(err)
			}
			return
		}
		select {
		case <-ticker.C:
		case <-fixture.ctx.Done():
			fixture.t.Fatal("native Git did not enter before its fixture deadline")
		}
	}
}

func (git *nativeParentControlGit) calls(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(git.directory, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	return len(strings.Fields(string(data)))
}

func nativeParentControlGitRequest() Message {
	return Message{Type: "operation-request", Action: "git-observe-commit", OperationID: "owned-observe",
		ExpectedSHA: strings.Repeat("a", 40), CommitMessage: "observe only",
		AuthorName: "Owned Fixture", AuthorEmail: "fixture@example.invalid"}
}

func TestNativeParentControlRejectsSourceResumeAsUnsupported(t *testing.T) {
	fixture := newNativeParentControlFixture(t)
	peer := fixture.peer()
	fixture.started(peer, true)
	for _, request := range []Message{
		{Type: "operation-request", Action: "source-resume", Data: nativeParentControlOtherCheckpoint},
		{Type: "operation-request", Action: "source-resume", OperationID: "invalid-data", Data: "not-a-checkpoint"},
		{Type: "operation-request", Action: "source-resume", OperationID: "old-protocol", Data: nativeParentControlOtherCheckpoint},
	} {
		fixture.write(peer, request)
		fixture.reply(peer, request, "operation requires its native Work or isolated browser owner")
	}
	drain := nativeParentControlDrain(nativeParentControlCheckpoint, nativeParentControlCheckpoint)
	fixture.write(peer, drain)
	fixture.reply(peer, drain, "")
	for range 2 {
		request := Message{Type: "operation-request", Action: "source-resume",
			OperationID: "cannot-unfence", Data: nativeParentControlOtherCheckpoint}
		fixture.write(peer, request)
		fixture.reply(peer, request, nativeParentControlFenced)
	}
	late := Message{Type: "operation-request", Action: "git-push", OperationID: "still-fenced"}
	fixture.write(peer, late)
	fixture.reply(peer, late, nativeParentControlFenced)
	if !fixture.source.ready.Load() || fixture.source.epoch.Load() != 7 {
		t.Fatal("unsupported Source resume changed the retained Source owner")
	}
	fixture.stop(peer)
}

func TestNativeParentControlStopRemainsReadableWhileWorkIsBlocked(t *testing.T) {
	git := newNativeParentControlGit(t)
	fixture := newNativeParentControlFixture(t)
	peer := fixture.peer()
	fixture.started(peer, true)
	fixture.write(peer, nativeParentControlGitRequest())
	git.wait(fixture)
	fixture.stop(peer)
	if git.process.Signal(syscall.Signal(0)) == nil || git.calls(t) != 1 || fixture.requests.Load() != 1 {
		t.Fatalf("native Stop did not join its one Git subprocess or reconnected: connections=%d", fixture.requests.Load())
	}
}

func TestNativeParentControlDrainRequiresExactWorkBarrierAndCheckpoint(t *testing.T) {
	for _, scenario := range []struct {
		name, id, barrier, expectedError string
	}{
		{"missing-id", "", "", nativeParentControlFenced},
		{"missing-barrier", nativeParentControlCheckpoint, "", "native Work writer barrier is unconfirmed"},
		{"different-barrier", nativeParentControlCheckpoint, nativeParentControlOtherCheckpoint, "native Work writer barrier is unconfirmed"},
		{"exact-barrier", nativeParentControlCheckpoint, nativeParentControlCheckpoint, ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newNativeParentControlFixture(t)
			peer := fixture.peer()
			fixture.started(peer, true)
			request := nativeParentControlDrain(scenario.id, scenario.barrier)
			fixture.write(peer, request)
			fixture.reply(peer, request, scenario.expectedError)
			different := nativeParentControlDrain(nativeParentControlOtherCheckpoint, nativeParentControlOtherCheckpoint)
			if scenario.id != "" && scenario.expectedError != "" {
				// Even an unconfirmed Work barrier retains its recorded ID;
				// a different drain cannot steal that checkpoint before retry.
				fixture.write(peer, different)
				fixture.reply(peer, different, nativeParentControlFenced)
			}
			exact := nativeParentControlDrain(nativeParentControlCheckpoint, nativeParentControlCheckpoint)
			fixture.write(peer, exact)
			fixture.reply(peer, exact, "")
			for _, action := range []string{"workspace-git", "git-push", "git-prepare-commit", "skills-install", "browser-inspection"} {
				late := Message{Type: "operation-request", Action: action, OperationID: "late-" + action}
				fixture.write(peer, late)
				// Exact fence errors distinguish refusal before dispatch from
				// an unavailable Git checkout, browser peer or skills payload.
				fixture.reply(peer, late, nativeParentControlFenced)
			}
			fixture.write(peer, different)
			fixture.reply(peer, different, nativeParentControlFenced)
			wrongBarrier := nativeParentControlDrain(nativeParentControlCheckpoint, nativeParentControlOtherCheckpoint)
			fixture.write(peer, wrongBarrier)
			fixture.reply(peer, wrongBarrier, "native Work writer barrier is unconfirmed")
			// Only the original checkpoint can reconcile after a failed or
			// successful response, with the same exact Work barrier.
			fixture.write(peer, exact)
			fixture.reply(peer, exact, "")
			fixture.stop(peer)
		})
	}
}
