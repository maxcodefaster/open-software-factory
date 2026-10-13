package connector

import (
	"context"
	"errors"
	"strings"
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
	if err := preparation.ready(); err != nil && !strings.Contains(err.Error(), "preparing") {
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
	if err := preparation.ready(); err != nil {
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
		_ = preparation.ready()
		<-started
		cancel()
		<-preparation.done
		err := preparation.ready()
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
	if err := preparation.ready(); err == nil {
		t.Fatal("stopped preparation accepted new demand")
	}
}
