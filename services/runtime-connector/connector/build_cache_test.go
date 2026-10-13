package connector

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestBuildCacheRetentionCannotDeleteImagesSourceOrVolumes(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	err := trimPrivateBuildCacheWith(parent, func(ctx context.Context, args []string) error {
		if ctx.Err() != nil {
			t.Fatal("Stop cancellation skipped bounded retained-cache maintenance")
		}
		deadline, bounded := ctx.Deadline()
		if !bounded || time.Until(deadline) > 15*time.Second {
			t.Fatal("cache maintenance has no short bound")
		}
		if !reflect.DeepEqual(args, []string{"builder", "prune", "--force", "--keep-storage", "1GB"}) {
			t.Fatalf("cache eviction can widen its deletion targets: %v", args)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = trimPrivateBuildCacheWith(parent, func(context.Context, []string) error { return errors.New("raw daemon credential must not escape") })
	if err == nil || err.Error() != "private build-cache retention could not be applied" {
		t.Fatal("cache failure was not bounded and sanitized")
	}
}
