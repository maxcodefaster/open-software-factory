//go:build linux

package workspacefiles

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRetryTransientSourceWaitsOutConnectionRaces(t *testing.T) {
	calls := 0
	err := retryTransientSource(context.Background(), []time.Duration{time.Millisecond, time.Millisecond}, func() error {
		calls++
		if calls < 3 {
			return &transientSourceError{"source checkout preparation failed: Failed to connect"}
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("expected success on the third attempt, got %v after %d calls", err, calls)
	}
}

func TestRetryTransientSourceStopsOnPermanentFailureAndExhaustion(t *testing.T) {
	permanent := errors.New("source checkout preparation failed: 403")
	calls := 0
	if err := retryTransientSource(context.Background(), []time.Duration{time.Millisecond}, func() error {
		calls++
		return permanent
	}); err != permanent || calls != 1 {
		t.Fatalf("a permanent failure must not retry, got %v after %d calls", err, calls)
	}
	calls = 0
	if err := retryTransientSource(context.Background(), []time.Duration{time.Millisecond}, func() error {
		calls++
		return &transientSourceError{"Failed to connect"}
	}); err == nil || calls != 2 {
		t.Fatalf("exhausted delays must return the failure after two calls, got %v after %d", err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls = 0
	if err := retryTransientSource(ctx, []time.Duration{time.Hour}, func() error {
		calls++
		return &transientSourceError{"Failed to connect"}
	}); err == nil || calls != 1 {
		t.Fatalf("a canceled context must stop waiting, got %v after %d", err, calls)
	}
}
