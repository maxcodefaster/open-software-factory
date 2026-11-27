package browser

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

type browserDiscardInput struct{ io.Writer }

func (browserDiscardInput) Close() error { return nil }

// Use the native worker with controlled process I/O. No container, proxy or
// host browser is started, and cleanup joins the same native worker owner.
func browserRuntimeFixture(t *testing.T) (*nativeBrowserWorker, browserRuntimeRequest) {
	t.Helper()
	worker, bootstrap, _ := nativeBrowserUnitWorker(t, true)
	worker.runtime.input = browserDiscardInput{io.Discard}
	worker.runtime.pageID, worker.runtime.app = 0, ""
	scope := bootstrap.Scope
	scope.ExpiresAt = time.Now().Add(20 * time.Second)
	scope.Call = browserToolCall{Name: "browser_open", Arguments: json.RawMessage(`{"app":"web"}`)}
	return worker, scope
}

func browserScopeMessage(worker *nativeBrowserWorker, scope browserRuntimeRequest, action string) protocol.Message {
	data, _ := json.Marshal(scope)
	return protocol.Message{Type: "operation-request", Action: action, OperationID: "operation-test",
		AttemptID: worker.assignment.RuntimeAttemptID, Generation: worker.assignment.Generation, Data: string(data)}
}

func TestBrowserFailedNavigationDoesNotClaimCheckoutOrAppContext(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	runtime := worker.runtime
	runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Declared App navigation exceeded its deadline"}]}`)}
	worker.observe = func(context.Context, browserRuntimeRequest, string) (*browserInspectionContext, error) {
		t.Error("failed navigation inspected Source as though the App had loaded")
		return nil, errors.New("unexpected inspection")
	}
	output, err := worker.call(scope)
	if err != nil {
		t.Fatal(err)
	}
	var result browserMCPContent
	if json.Unmarshal([]byte(output), &result) != nil || !result.IsError || result.StructuredContent != nil ||
		len(result.Content) != 1 || result.Content[0].Text != "Declared App navigation exceeded its deadline" {
		t.Fatalf("failed navigation claimed an observation: %s", output)
	}
	if runtime.pendingApp != "web" || runtime.pageID != 0 || runtime.app != "" {
		t.Fatal("failed navigation fabricated a confirmed page instead of retaining its exact intended App")
	}
	if _, err := worker.call(scope); err == nil || !strings.Contains(err.Error(), "browser_snapshot") {
		t.Fatal("failed navigation could be replayed before observation", err)
	}
}

func TestBrowserRecoveryRequiresExactlyOneSelectedDeclaredPage(t *testing.T) {
	for _, pages := range []string{
		`[]`,
		`[{"id":2,"url":"about:blank","selected":true}]`,
		`[{"id":2,"url":"http://foreign.factory.invalid/","selected":true}]`,
		`[{"id":2,"url":"http://web.factory.invalid.evil/","selected":true}]`,
		`[{"id":2,"url":"http://web.factory.invalid/","selected":false}]`,
		`[{"id":0,"url":"http://web.factory.invalid/","selected":true}]`,
		`[{"id":2,"url":"http://web.factory.invalid/","selected":true},{"id":3,"url":"http://web.factory.invalid/other","selected":true}]`,
	} {
		runtime := &browserRuntime{pageID: 1, app: "previous", pendingApp: "web"}
		if err := runtime.selectDeclaredPage(json.RawMessage(`{"structuredContent":{"pages":`+pages+`}}`), "web"); err == nil {
			t.Fatal("unconfirmed or foreign page was adopted", pages)
		}
		if runtime.pageID != 1 || runtime.app != "previous" || runtime.pendingApp != "web" {
			t.Fatal("rejected observation changed the current page binding")
		}
	}
	runtime := &browserRuntime{pendingApp: "web"}
	if err := runtime.selectDeclaredPage(json.RawMessage(`{"isError":true,"structuredContent":{"pages":[{"id":2,"url":"http://web.factory.invalid/slow","selected":true}]}}`), "web"); err == nil {
		t.Fatal("failed metadata read claimed a selected App")
	}
	if err := runtime.selectDeclaredPage(json.RawMessage(`{"structuredContent":{"pages":[{"id":1,"url":"about:blank","selected":false},{"id":2,"url":"http://web.factory.invalid/slow","selected":true}]}}`), "web"); err != nil {
		t.Fatal(err)
	}
	if runtime.pageID != 2 || runtime.app != "web" || runtime.pendingApp != "" {
		t.Fatal("exact declared page was not adopted after the read-only observation")
	}
}

func TestBrowserRenewalCanKeepAnInFlightCallAlive(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	runtime := worker.runtime
	scope.ExpiresAt = time.Now().Add(time.Second)
	input := browserRecordingInput{started: make(chan struct{}, 1)}
	runtime.input = input
	if err := runtime.renewAuthority(scope, false); err != nil {
		t.Fatal(err)
	}
	lease, end, err := browserAuthorityContext(runtime.ctx, filepath.Join(runtime.directory, "config", "authority.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	go func() {
		<-lease.Done()
		runtime.cancel()
	}()
	done := make(chan error, 1)
	joined := false
	go func() {
		_, err := worker.call(scope)
		done <- err
	}()
	defer func() {
		runtime.cancel()
		if !joined {
			<-done
		}
	}()
	select {
	case <-input.started:
	case <-time.After(time.Second):
		t.Fatal("browser call did not start")
	}
	renewal := scope
	renewal.ExpiresAt = time.Now().Add(25 * time.Second)
	renewed := make(chan protocol.Message, 1)
	go func() {
		renewed <- worker.handle(context.Background(), browserScopeMessage(worker, renewal, "browser-renew"))
	}()
	select {
	case response := <-renewed:
		if response.Error != "" {
			t.Fatal("renewal failed", response.Error)
		}
	case <-time.After(time.Second):
		t.Fatal("renewal blocked behind the browser call")
	}
	// A known tool error avoids fabricating checkout or page observations.
	runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"fixture observation"}]}`)}
	select {
	case err := <-done:
		joined = true
		if err != nil {
			t.Fatal("renewed browser call failed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("renewed browser call did not settle")
	}
}

func TestBrowserOpenAllowsColdChromeStartupBeforeItsNavigationDeadline(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	runtime := worker.runtime
	replied := make(chan struct{})
	go func() {
		defer close(replied)
		select {
		case <-time.After(16 * time.Second):
			runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Known fixture navigation outcome after cold launch"}]}`)}
		case <-runtime.ctx.Done():
		}
	}()
	defer func() { runtime.cancel(); <-replied }()
	// Exercise the real native RPC wait, not only a timeout constant. Cold
	// Chrome startup is outside upstream's ten-second navigation timeout.
	if _, err := worker.call(scope); err != nil {
		t.Fatalf("cold browser_open was interrupted before its known result: %v", err)
	}
}

func TestBrowserRuntimeExecutionScope(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	valid := browserScopeMessage(worker, scope, "browser-call")
	if _, err := decodeBrowserRuntimeRequest(valid, worker.assignment); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*protocol.Message){
		func(m *protocol.Message) { m.AttemptID = "other-attempt" },
		func(m *protocol.Message) { m.Generation++ },
		func(m *protocol.Message) { m.OperationID = "" },
		func(m *protocol.Message) { m.Data = strings.Replace(m.Data, scope.OwnerID, "raw-secret", 1) },
		func(m *protocol.Message) { m.Data = strings.Replace(m.Data, scope.SessionID, "../escape", 1) },
		func(m *protocol.Message) { m.Data += `{}` },
		func(m *protocol.Message) { m.Data = strings.Replace(m.Data, `"turnId"`, `"unapproved"`, 1) },
	} {
		invalid := valid
		change(&invalid)
		if _, err := decodeBrowserRuntimeRequest(invalid, worker.assignment); err == nil {
			t.Fatalf("accepted invalid scope: %+v", invalid)
		}
	}
	for _, expiry := range []time.Time{time.Now().Add(-time.Second), time.Now().Add(time.Minute)} {
		scope.ExpiresAt = expiry
		if _, err := decodeBrowserRuntimeRequest(browserScopeMessage(worker, scope, "browser-call"), worker.assignment); err == nil {
			t.Fatal("accepted expired or excessive lease")
		}
		if _, err := decodeBrowserRuntimeRequest(browserScopeMessage(worker, scope, "browser-close"), worker.assignment); err != nil {
			t.Fatal("must allow exact owned cleanup after expiry", err)
		}
	}
}

func TestBrowserRuntimeDisconnectedRequestCannotCreate(t *testing.T) {
	worker, bootstrap, _ := nativeBrowserUnitWorker(t, false)
	scope := bootstrap.Scope
	scope.ExpiresAt = time.Now().Add(20 * time.Second)
	scope.Call = browserToolCall{Name: "browser_open", Arguments: json.RawMessage(`{"app":"web"}`)}
	connection, disconnect := context.WithCancel(context.Background())
	disconnect()
	if response := worker.handle(connection, browserScopeMessage(worker, scope, "browser-call")); response.Error == "" {
		t.Fatal("late request was accepted")
	}
	if _, err := os.Stat(worker.runtime.directory); !os.IsNotExist(err) {
		t.Fatal("late request touched runtime state", err)
	}
	if worker.runtime.command != nil || !worker.runtime.expiresAt.IsZero() {
		t.Fatal("late request started tools or execution authority")
	}
}

func TestBrowserRuntimeCleanupRejectsForeignOwnerAndCannotRevive(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	foreign := scope
	foreign.OwnerID = strings.Repeat("e", 64)
	if response := worker.handle(context.Background(), browserScopeMessage(worker, foreign, "browser-close")); response.Error == "" {
		t.Fatal("foreign owner closed the native worker")
	}
	if worker.runtime.ctx.Err() != nil || worker.runtime.closed {
		t.Fatal("foreign cleanup revoked the admitted session")
	}
	for range 2 {
		if response := worker.handle(context.Background(), browserScopeMessage(worker, scope, "browser-close")); response.Error != "" {
			t.Fatal("exact owned close failed", response.Error)
		}
	}
	if response := worker.handle(context.Background(), browserScopeMessage(worker, scope, "browser-call")); response.Error == "" {
		t.Fatal("closed native session was revived")
	}
}
