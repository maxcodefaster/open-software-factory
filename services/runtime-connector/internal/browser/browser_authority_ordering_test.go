package browser

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestDelayedBrowserCallCannotReplaceNewerExplicitRenewal(t *testing.T) {
	for _, recording := range []bool{false, true} {
		t.Run(map[bool]string{false: "App observation", true: "recording"}[recording], func(t *testing.T) {
			worker, scope := browserRuntimeFixture(t)
			scope.ExpiresAt = time.Now().Add(500 * time.Millisecond)
			runtime := worker.runtime
			runtime.expiresAt, runtime.app, runtime.pageID = scope.ExpiresAt, "web", 1
			renewal := scope
			renewal.ExpiresAt = time.Now().Add(2 * time.Second)
			if response := worker.handle(context.Background(), browserScopeMessage(worker, renewal, "browser-renew")); response.Error != "" {
				t.Fatal(response.Error)
			}
			leasePath := filepath.Join(runtime.directory, "config", "authority.json")
			lease, end, err := browserAuthorityContext(runtime.ctx, leasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer end()
			scope.Call = browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}
			runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Known fixture observation"}]}`)}
			if recording {
				// Exercise real recording admission and its joined RPC,
				// without fabricating a recording or successful App result.
				response := worker.handle(context.Background(), browserScopeMessage(worker, scope, "browser-recording-start"))
				if response.Error != "recording encoder outcome unavailable" {
					t.Fatal("recording did not reach its known native RPC outcome", response.Error)
				}
			} else {
				if _, err := worker.call(scope); err != nil {
					t.Fatal(err)
				}
			}
			current, err := readBrowserAuthority(leasePath)
			if err != nil || !current.ExpiresAt.Equal(renewal.ExpiresAt) {
				t.Fatalf("delayed call replaced its newer explicit renewal: got %v, want %v, error %v",
					current.ExpiresAt, renewal.ExpiresAt, err)
			}
			select {
			case <-lease.Done():
				t.Fatal("current renewal expired at an older App call's deadline")
			case <-time.After(time.Until(scope.ExpiresAt) + 100*time.Millisecond):
			}
			runtime.cancel()
			select {
			case <-lease.Done():
			case <-time.After(time.Second):
				t.Fatal("cancellation did not end the independently enforced lease")
			}
			renewal.ExpiresAt = time.Now().Add(time.Second)
			if response := worker.handle(context.Background(), browserScopeMessage(worker, renewal, "browser-renew")); response.Error == "" {
				t.Fatal("renewal revived cancelled browser execution")
			}
		})
	}
}

func TestExplicitBrowserRenewalCanStillShortenAndCannotReviveExpiredAuthority(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	runtime := worker.runtime
	runtime.expiresAt = scope.ExpiresAt
	shorter := scope
	shorter.ExpiresAt = time.Now().Add(250 * time.Millisecond)
	if response := worker.handle(context.Background(), browserScopeMessage(worker, shorter, "browser-renew")); response.Error != "" {
		t.Fatal(response.Error)
	}
	path := filepath.Join(runtime.directory, "config", "authority.json")
	current, err := readBrowserAuthority(path)
	if err != nil || !current.ExpiresAt.Equal(shorter.ExpiresAt) {
		t.Fatal("explicit renewal could not shorten the same live authority", current, err)
	}
	lease, end, err := browserAuthorityContext(runtime.ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	select {
	case <-lease.Done():
	case <-time.After(time.Second):
		t.Fatal("shortened authority survived its independently enforced deadline")
	}
	scope.ExpiresAt = time.Now().Add(time.Second)
	if response := worker.handle(context.Background(), browserScopeMessage(worker, scope, "browser-renew")); response.Error == "" {
		t.Fatal("late renewal revived expired browser authority")
	}
}
