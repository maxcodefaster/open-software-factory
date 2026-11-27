package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

type nativeBrowserUnitInput struct{ bytes.Buffer }

func (*nativeBrowserUnitInput) Close() error { return nil }

func nativeBrowserUnitWorker(t *testing.T, opened bool) (*nativeBrowserWorker, nativeBrowserBootstrap, *nativeBrowserUnitInput) {
	t.Helper()
	bootstrap := nativeBrowserUnitBootstrap()
	worker := newNativeBrowserWorker(context.Background(), protocol.Assignment{
		RuntimeAttemptID: bootstrap.AttemptID, Generation: bootstrap.Generation, Channels: bootstrap.Apps,
	}, bootstrap.Scope)
	worker.runtime.directory = filepath.Join(t.TempDir(), "not-created")
	input := &nativeBrowserUnitInput{}
	worker.startProxy = func(context.Context) (func(), error) {
		t.Error("unit operation attempted to start a real Browser proxy")
		return nil, errors.New("host execution is forbidden in this fixture")
	}
	worker.command = func(context.Context, string, ...string) ([]byte, error) {
		t.Error("unit operation attempted to start a host command")
		return nil, errors.New("host execution is forbidden in this fixture")
	}
	if opened {
		worker.runtime.directory = t.TempDir()
		worker.runtime.command = &exec.Cmd{}
		worker.runtime.input = input
		worker.runtime.responses = make(chan browserMCPReply, 4)
		worker.runtime.pageID, worker.runtime.app = 7, "web"
	}
	t.Cleanup(func() {
		if err := worker.close(); err != nil {
			t.Error(err)
		}
	})
	return worker, bootstrap, input
}

func TestNativeBrowserWorkerUnitRenewBeforeFirstCallDoesNotCreateExecution(t *testing.T) {
	worker, bootstrap, _ := nativeBrowserUnitWorker(t, false)
	for range 2 {
		scope := bootstrap.Scope
		scope.ExpiresAt = time.Now().Add(20 * time.Second)
		message := nativeBrowserUnitOperation(t, bootstrap, scope, "browser-renew")
		response := worker.handle(context.Background(), message)
		if response.Error != "" || response.Type != "operation-response" ||
			response.OperationID != message.OperationID || response.Action != message.Action || response.Data != "" {
			t.Fatalf("fresh pre-call renewal failed: %+v", response)
		}
		if worker.runtime.command != nil || !worker.runtime.expiresAt.IsZero() || worker.proxyStop != nil {
			t.Fatal("renewal before first call created execution or a lease")
		}
		if _, err := os.Stat(worker.runtime.directory); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("renewal before first call created control storage", err)
		}
	}
}

func TestNativeBrowserWorkerUnitRejectsUnadmittedOrEndedScopeWithoutExecution(t *testing.T) {
	for _, variant := range []string{
		"attempt", "generation", "session", "turn", "owner", "agent-session", "operation",
		"expired", "excessive-lease", "unknown-field", "trailing-json", "oversize", "caller-cancelled",
		"worker-cancelled", "unsupported-action", "unopened-snapshot",
	} {
		t.Run(variant, func(t *testing.T) {
			worker, bootstrap, _ := nativeBrowserUnitWorker(t, false)
			scope := bootstrap.Scope
			scope.ExpiresAt = time.Now().Add(20 * time.Second)
			switch variant {
			case "session":
				scope.SessionID = "01994a7d-0000-7000-8000-000000000099"
			case "turn":
				scope.TurnID = "01994a7d-0000-7000-8000-000000000099"
			case "owner":
				scope.OwnerID = strings.Repeat("d", 64)
			case "agent-session":
				scope.AgentSessionID = "ses_other"
			case "expired":
				scope.ExpiresAt = time.Now().Add(-time.Second)
			case "excessive-lease":
				scope.ExpiresAt = time.Now().Add(time.Minute)
			case "unopened-snapshot":
				scope.Call = browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}
			}
			message := nativeBrowserUnitOperation(t, bootstrap, scope, "browser-renew")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch variant {
			case "attempt":
				message.AttemptID = "01994a7d-0000-7000-8000-000000000099"
			case "generation":
				message.Generation++
			case "operation":
				message.OperationID = ""
			case "unknown-field":
				message.Data = strings.Replace(message.Data, `"ownerId"`, `"unknown"`, 1)
			case "trailing-json":
				message.Data += "{}"
			case "oversize":
				message.Data = strings.Repeat(" ", 16385)
			case "caller-cancelled":
				cancel()
			case "worker-cancelled":
				worker.runtime.cancel()
			case "unsupported-action":
				message.Action = "browser-other"
			case "unopened-snapshot":
				message.Action = "browser-call"
			}
			if response := worker.handle(ctx, message); response.Error == "" {
				t.Fatal("unadmitted operation was acknowledged")
			}
			if worker.runtime.command != nil {
				t.Fatal("unadmitted operation created execution")
			}
			if _, err := os.Stat(worker.runtime.directory); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("unadmitted operation created control storage", err)
			}
		})
	}
}

func TestNativeBrowserWorkerUnitFreshCallsUseOwnedContextAndDoNotRegressRenewal(t *testing.T) {
	worker, bootstrap, input := nativeBrowserUnitWorker(t, true)
	observations := 0
	worker.observe = func(_ context.Context, scope browserRuntimeRequest, app string) (*browserInspectionContext, error) {
		observations++
		if !sameBrowserScope(scope, bootstrap.Scope) || scope.ExpiresAt.IsZero() || app != "web" {
			t.Error("observation lost the fresh operation scope")
		}
		return &browserInspectionContext{
			SessionID: scope.SessionID, TurnID: scope.TurnID, AttemptID: bootstrap.AttemptID,
			Generation: bootstrap.Generation, App: app, HeadCommit: strings.Repeat("c", 40),
		}, nil
	}
	scope := bootstrap.Scope
	scope.ExpiresAt = time.Now().Add(20 * time.Second)
	scope.Call = browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}
	for sequence := 1; sequence <= 2; sequence++ {
		worker.runtime.responses <- browserMCPReply{ID: sequence, Result: json.RawMessage(`{
			"content":[{"type":"text","text":"Current App snapshot"}],
			"structuredContent":{"snapshot":{"role":"RootWebArea","url":"http://web.factory.invalid/form?private=value#fragment"}}
		}`)}
		response := worker.handle(context.Background(), nativeBrowserUnitOperation(t, bootstrap, scope, "browser-call"))
		if response.Error != "" {
			t.Fatal(response.Error)
		}
		var result browserMCPContent
		if err := json.Unmarshal([]byte(response.Data), &result); err != nil {
			t.Fatal(err)
		}
		if result.IsError || result.StructuredContent == nil || result.StructuredContent.App != "web" ||
			result.StructuredContent.HeadCommit != strings.Repeat("c", 40) || result.StructuredContent.Page != "/form" {
			t.Fatalf("call lost native ownership or retained a private URL: %s", response.Data)
		}
		if sequence == 1 {
			renewal := scope
			renewal.ExpiresAt = time.Now().Add(25 * time.Second)
			response := worker.handle(context.Background(), nativeBrowserUnitOperation(t, bootstrap, renewal, "browser-renew"))
			if response.Error != "" || !worker.runtime.expiresAt.Equal(renewal.ExpiresAt) {
				t.Fatal("started runtime did not renew its existing authority", response.Error)
			}
		}
	}
	if observations != 2 || !worker.runtime.expiresAt.After(scope.ExpiresAt) {
		t.Fatal("later call overwrote the newer lease or skipped native observations")
	}
	decoder := json.NewDecoder(&input.Buffer)
	for sequence := 1; sequence <= 2; sequence++ {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
			Params struct {
				Name      string `json:"name"`
				Arguments struct {
					PageID int `json:"pageId"`
				} `json:"arguments"`
			} `json:"params"`
		}
		if err := decoder.Decode(&request); err != nil || request.ID != sequence ||
			request.Method != "tools/call" || request.Params.Name != "take_snapshot" || request.Params.Arguments.PageID != 7 {
			t.Fatal("native worker changed the admitted MCP dispatch", err)
		}
	}
}

func TestNativeBrowserWorkerUnitHTTPObservationDoesNotDispatchMCP(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		t.Run(map[bool]string{false: "observed", true: "unavailable"}[unavailable], func(t *testing.T) {
			worker, bootstrap, input := nativeBrowserUnitWorker(t, true)
			scope := bootstrap.Scope
			scope.ExpiresAt = time.Now().Add(20 * time.Second)
			scope.Call = browserToolCall{Name: "browser_http_observations", Arguments: json.RawMessage(`{"after":3}`)}
			reads, observations := 0, 0
			worker.httpRead = func(ctx context.Context, app string, after uint64) (json.RawMessage, error) {
				reads++
				if ctx.Err() != nil || app != "web" || after != 3 {
					t.Error("native HTTP read changed its declared App or cursor")
				}
				if unavailable {
					return nil, errors.New("private upstream diagnostic")
				}
				return json.RawMessage(`{"content":[{"type":"text","text":"bounded HTTP metadata"}]}`), nil
			}
			worker.observe = func(context.Context, browserRuntimeRequest, string) (*browserInspectionContext, error) {
				observations++
				return &browserInspectionContext{
					SessionID: scope.SessionID, TurnID: scope.TurnID, AttemptID: bootstrap.AttemptID,
					Generation: bootstrap.Generation, App: "web", HeadCommit: strings.Repeat("c", 40),
				}, nil
			}
			response := worker.handle(context.Background(), nativeBrowserUnitOperation(t, bootstrap, scope, "browser-call"))
			if response.Error != "" || reads != 1 || input.Len() != 0 || worker.runtime.sequence != 0 {
				t.Fatal("HTTP metadata operation dispatched MCP or failed its local reader", response.Error)
			}
			if unavailable {
				if !strings.Contains(response.Data, `"isError":true`) ||
					!strings.Contains(response.Data, "No App request ran") ||
					strings.Contains(response.Data, "private upstream diagnostic") || observations != 0 {
					t.Fatal("unavailable metadata fabricated success or leaked a private diagnostic")
				}
			} else if !strings.Contains(response.Data, "bounded HTTP metadata") || observations != 1 {
				t.Fatal("local HTTP observation lost its owned context")
			}
		})
	}
}

func TestNativeBrowserWorkerUnitCloseAfterExpiryIsIdempotent(t *testing.T) {
	worker, bootstrap, _ := nativeBrowserUnitWorker(t, true)
	scope := bootstrap.Scope
	scope.ExpiresAt = time.Now().Add(-time.Second)
	message := nativeBrowserUnitOperation(t, bootstrap, scope, "browser-close")
	for range 2 {
		if response := worker.handle(context.Background(), message); response.Error != "" {
			t.Fatal("exact owned close failed after lease expiry", response.Error)
		}
	}
	if !worker.runtime.closed || worker.runtime.ctx.Err() == nil {
		t.Fatal("owned close did not end execution")
	}
}
