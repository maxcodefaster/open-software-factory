package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUnusedBrowserToolsDoNotDownloadAtComputeStartup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	preparation := prepareBrowserImage(ctx, func(context.Context) error {
		close(started)
		return nil
	})
	select {
	case <-started:
		t.Fatal("unused browser image downloads during compute startup")
	case <-time.After(100 * time.Millisecond):
	}
	if err := preparation.ready("turn-test"); err != nil && !strings.Contains(err.Error(), "preparing") {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("actual browser demand did not start image preparation")
	}
	<-preparation.done
}

func TestBrowserPreparationDoesNotBlockEditorStartupOrConsumeALease(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	started := make(chan struct{})
	preparation := prepareBrowserImage(ctx, func(ctx context.Context) error {
		close(started)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	manager, scope := browserRuntimeFixture(t)
	manager.preparation = preparation
	manager.docker = func(context.Context, ...string) ([]byte, error) {
		t.Fatal("pending browser created a container")
		return nil, nil
	}
	response := manager.handle(ctx, browserScopeMessage(manager, scope, "browser-call"))
	<-started
	if !strings.Contains(response.Error, "preparing") || len(manager.sessions) != 0 {
		t.Fatal("pending image claimed an observation or consumed a session", response)
	}
	close(release)
	<-preparation.done
	if err := preparation.ready(scope.TurnID); err != nil {
		t.Fatal("exactly confirmed image did not become usable", err)
	}
}

func TestBrowserPreparationFailureAndStopRemainBounded(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		started := make(chan struct{})
		preparation := prepareBrowserImage(ctx, func(ctx context.Context) error {
			close(started)
			if cancelled {
				<-ctx.Done()
				return ctx.Err()
			}
			return errors.New("private-registry-secret")
		})
		_ = preparation.ready("turn-test")
		<-started
		cancel()
		<-preparation.done
		err := preparation.ready("turn-test")
		if err == nil || strings.Contains(err.Error(), "private-registry-secret") {
			t.Fatal("failure disclosed diagnostics or became ready", err)
		}
	}
}

func TestStoppingUnusedBrowserPreparationCreatesNoWorker(t *testing.T) {
	preparation := prepareBrowserImage(context.Background(), func(context.Context) error {
		t.Error("Stop started an unused download")
		return nil
	})
	preparation.stop()
	preparation.stop()
	if err := preparation.ready("turn-test"); err == nil {
		t.Fatal("stopped preparation accepted new demand")
	}
}

func TestFailedBrowserPreparationDoesNotPoisonANewAuthorizedTurn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var attempts atomic.Int32
	release := make(chan struct{})
	preparation := prepareBrowserImage(ctx, func(ctx context.Context) error {
		if attempts.Add(1) == 1 {
			return errors.New("private-registry-secret")
		}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	defer preparation.stop()
	manager, scope := browserRuntimeFixture(t)
	manager.preparation = preparation
	manager.docker = func(context.Context, ...string) ([]byte, error) {
		t.Fatal("unconfirmed preparation created a browser or replayed an App call")
		return nil, nil
	}
	first := manager.handle(ctx, browserScopeMessage(manager, scope, "browser-call"))
	if !strings.Contains(first.Error, "preparing") {
		t.Fatal("first preparation did not remain a pre-execution wait", first)
	}
	<-preparation.done
	failed := manager.handle(ctx, browserScopeMessage(manager, scope, "browser-call"))
	if !strings.Contains(failed.Error, "could not prepare") || strings.Contains(failed.Error, "private-registry-secret") {
		t.Fatal("the settled failure was not retained safely", failed)
	}
	if attempts.Load() != 1 {
		t.Fatal("the same failed turn silently restarted preparation")
	}
	scope.TurnID = "11111111-1111-4111-8111-111111111111"
	scope.SessionID = "22222222-2222-4222-8222-222222222222"
	next := manager.handle(ctx, browserScopeMessage(manager, scope, "browser-call"))
	if !strings.Contains(next.Error, "preparing") {
		t.Fatal("a fresh authorized turn still requires a Workspace restart", next)
	}
	var probes sync.WaitGroup
	for range 16 {
		probes.Go(func() {
			response := manager.handle(ctx, browserScopeMessage(manager, scope, "browser-call"))
			if !strings.Contains(response.Error, "preparing") {
				t.Error("parallel readiness lost its single pending image worker", response)
			}
		})
	}
	probes.Wait()
	close(release)
	<-preparation.done
	if attempts.Load() != 2 || len(manager.sessions) != 0 {
		t.Fatal("preparation recovery repeated browser execution or lost its new attempt")
	}
	if err := preparation.ready("later-turn"); err != nil || attempts.Load() != 2 {
		t.Fatal("a later turn downloaded an already confirmed immutable image", err)
	}
	preparation.stop()
	if err := preparation.ready("stopped-turn"); err == nil || attempts.Load() != 2 {
		t.Fatal("Stop admitted another image worker", err)
	}
}

func TestRejectedBrowserScopesDoNotStartImagePreparation(t *testing.T) {
	for _, scenario := range []string{"expired", "cancelled-control", "cancelled-manager", "ended", "unknown-app", "not-open"} {
		t.Run(scenario, func(t *testing.T) {
			var attempts atomic.Int32
			preparation := prepareBrowserImage(context.Background(), func(context.Context) error {
				attempts.Add(1)
				return nil
			})
			manager, scope := browserRuntimeFixture(t)
			manager.preparation = preparation
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch scenario {
			case "expired":
				scope.ExpiresAt = time.Now().Add(-time.Second)
			case "cancelled-control":
				cancel()
			case "cancelled-manager":
				manager.ctx = ctx
				cancel()
				ctx = context.Background()
			case "ended":
				directory := manager.directory(scope.SessionID)
				if err := os.MkdirAll(directory, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(directory, "ended"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "unknown-app":
				scope.Call.Arguments = json.RawMessage(`{"app":"unassigned"}`)
			case "not-open":
				scope.Call = browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}
			}
			response := manager.handle(ctx, browserScopeMessage(manager, scope, "browser-call"))
			preparation.stop()
			if response.Error == "" || attempts.Load() != 0 || len(manager.sessions) != 0 {
				t.Fatal("a rejected browser call started image preparation or execution", response, attempts.Load())
			}
		})
	}
}
