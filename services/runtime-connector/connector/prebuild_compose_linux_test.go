package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrebuildComposeConsumerUsesMemoryBackedOverrideWithoutDroppingHooks(t *testing.T) {
	assignment, _ := composePrebuildRepository(t)
	source, err := os.ReadFile(filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	// Drive the actual consumer entry using its read-configuration boundary.
	// The separate producer's Compose admission cannot mask a consumer fallback.
	encoded, _ := json.Marshal(map[string]any{"configuration": json.RawMessage(source)})
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '%s'\n", encoded)
	if err := os.WriteFile(filepath.Join(bin, "devcontainer"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nprintf '{}\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	image := "registry.factory/prebuilds/project-one@sha256:" + strings.Repeat("c", 64)
	path, cleanup, err := preparePrebuildConsumer(context.Background(), assignment, image)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	saved, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(saved), `"required-project-setup"`) ||
		!strings.Contains(string(saved), `"dockerComposeFile"`) || strings.Contains(string(saved), `"build"`) {
		t.Fatalf("real Compose consumer override is incomplete: %s: %v", saved, err)
	}
}
