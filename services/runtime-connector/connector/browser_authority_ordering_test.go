package connector

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDelayedBrowserCallCannotReplaceNewerExplicitRenewal(t *testing.T) {
	for _, recording := range []bool{false, true} {
		t.Run(map[bool]string{false: "App observation", true: "recording"}[recording], func(t *testing.T) {
			manager, scope := browserRuntimeFixture(t)
			scope.ExpiresAt = time.Now().Add(500 * time.Millisecond)
			directory := manager.directory(scope.SessionID)
			if err := os.MkdirAll(filepath.Join(directory, "config"), 0755); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime := &browserRuntime{
				scope: scope, directory: directory, ctx: ctx, cancel: cancel,
				expiresAt: scope.ExpiresAt, command: &exec.Cmd{},
				input: browserDiscardInput{io.Discard}, responses: make(chan browserMCPReply, 1),
				app: "web", pageID: 1,
			}
			manager.sessions[scope.SessionID] = runtime
			manager.docker = func(context.Context, ...string) ([]byte, error) {
				return nil, nil
			}
			renewal := scope
			renewal.ExpiresAt = time.Now().Add(2 * time.Second)
			if err := manager.renew(renewal); err != nil {
				t.Fatal(err)
			}
			leasePath := filepath.Join(directory, "config", "authority.json")
			lease, end, err := browserAuthorityContext(ctx, leasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer end()
			scope.Call = browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}
			runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Known fixture observation"}]}`)}
			if recording {
				// Exercise real recording admission and its joined RPC,
				// without fabricating a recording or successful App result.
				_, _ = manager.recording(ctx, scope, "browser-recording-start")
			} else {
				if _, err := manager.call(ctx, scope); err != nil {
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
			cancel()
			select {
			case <-lease.Done():
			case <-time.After(time.Second):
				t.Fatal("cancellation did not end the independently enforced lease")
			}
			renewal.ExpiresAt = time.Now().Add(time.Second)
			if err := manager.renew(renewal); err == nil {
				t.Fatal("renewal revived cancelled browser execution")
			}
		})
	}
}

func TestExplicitBrowserRenewalCanStillShortenAndCannotReviveExpiredAuthority(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &browserRuntime{
		scope: scope, directory: manager.directory(scope.SessionID),
		ctx: ctx, cancel: cancel, expiresAt: scope.ExpiresAt,
	}
	manager.sessions[scope.SessionID] = runtime
	shorter := scope
	shorter.ExpiresAt = time.Now().Add(250 * time.Millisecond)
	if err := manager.renew(shorter); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(runtime.directory, "config", "authority.json")
	current, err := readBrowserAuthority(path)
	if err != nil || !current.ExpiresAt.Equal(shorter.ExpiresAt) {
		t.Fatal("explicit renewal could not shorten the same live authority", current, err)
	}
	lease, end, err := browserAuthorityContext(ctx, path)
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
	if err := manager.renew(scope); err == nil {
		t.Fatal("late renewal revived expired browser authority")
	}
}
