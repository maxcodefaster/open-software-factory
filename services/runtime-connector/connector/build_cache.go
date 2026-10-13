package connector

import (
	"context"
	"errors"
	"os/exec"
	"time"
)

// Docker prunes only unused build cache in this Workspace's private daemon.
// Checkout, installed dependencies, images and named volumes are not deletion targets.
func trimPrivateBuildCache(parent context.Context) error {
	return trimPrivateBuildCacheWith(parent, func(ctx context.Context, args []string) error {
		return exec.CommandContext(ctx, "docker", args...).Run()
	})
}

func trimPrivateBuildCacheWith(parent context.Context, run func(context.Context, []string) error) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 15*time.Second)
	defer cancel()
	if err := run(ctx, []string{"builder", "prune", "--force", "--keep-storage", "1GB"}); err != nil {
		return errors.New("private build-cache retention could not be applied")
	}
	return nil
}
