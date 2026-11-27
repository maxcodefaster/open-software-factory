package gitops

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func TestDevelopmentComputeCannotInitializeMissingCanonicalSource(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // No Git or repository hook may run on this failure path.
	assignment := protocol.Assignment{
		WorkspaceFolder:   filepath.Join(t.TempDir(), "project"),
		PreserveWorkspace: true,
		RepositoryURL:     "https://example.invalid/owned.git",
	}
	err := CheckoutProject(context.Background(), assignment)
	if err == nil || err.Error() != "canonical Workspace source is not initialized" {
		t.Fatalf("missing source must fail before any clone: %v", err)
	}
}
