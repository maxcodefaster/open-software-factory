//go:build !linux

package gitops

import "context"

// The admitted Source runs on Linux. Host-only Git fixtures never own a native checkout.
func EnsureTrackedWorkspaceOwnership(context.Context, string) error { return nil }
