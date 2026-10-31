//go:build !linux

package connector

import "context"

// The admitted Source and its UID mapping run on Linux. Host-only Git fixtures
// do not operate on a Factorybox canonical checkout.
func ensureTrackedWorkspaceOwnership(context.Context, string) error { return nil }
