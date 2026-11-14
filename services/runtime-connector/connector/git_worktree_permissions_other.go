//go:build !linux

package connector

import "context"

// The admitted Source runs on Linux. Host-only Git fixtures never own a native checkout.
func ensureTrackedWorkspaceOwnership(context.Context, string) error { return nil }
