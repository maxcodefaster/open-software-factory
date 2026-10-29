package connector

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDevcontainerFailureKeepsBoundedRedactedCause(t *testing.T) {
	directory := t.TempDir()
	scripts := map[string]string{
		"docker": "#!/bin/sh\nexit 0\n",
		"devcontainer": `#!/bin/sh
printf '%s\n' '{"outcome":"error","description":"An error occurred building the container."}'
printf '%s\n' '{"type":"text","text":"ERROR: failed to solve: package installation failed; GH_TOKEN=owned-private-value; https://user:owned-private-value@example.test/archive"}' >&2
exit 1
`,
	}
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := startDevcontainer(context.Background(), Assignment{
		WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
		ComposeProjectName: "owned_diagnostic", RuntimeAttemptID: "owned-diagnostic", Generation: 1,
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if err == nil || !strings.Contains(err.Error(), "package installation failed") {
		t.Fatalf("lost the actual Dev Containers CLI failure: %v", err)
	}
	if strings.Contains(err.Error(), "owned-private-value") || strings.Contains(err.Error(), "user:") {
		t.Fatalf("diagnostic exposed credentials: %v", err)
	}
	if len(err.Error()) > 1200 {
		t.Fatalf("unbounded public diagnostic: %d bytes", len(err.Error()))
	}
}

func TestDevcontainerConfigurationFailureKeepsBoundedRedactedCause(t *testing.T) {
	directory := t.TempDir()
	script := `#!/bin/sh
printf '%s\n' '{"type":"text","text":"Error: metadata lookup failed for the Dockerfile base image; GH_TOKEN=owned-private-value; https://user:owned-private-value@example.test/archive"}' >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := validateDevcontainer(context.Background(), Assignment{
		WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if err == nil || !strings.Contains(err.Error(), "metadata lookup failed") {
		t.Fatalf("lost the actual configuration failure: %v", err)
	}
	if strings.Contains(err.Error(), "owned-private-value") || strings.Contains(err.Error(), "user:") {
		t.Fatalf("configuration diagnostic exposed credentials: %v", err)
	}
	if len(err.Error()) > 1200 {
		t.Fatalf("unbounded configuration diagnostic: %d bytes", len(err.Error()))
	}
}

func TestDevcontainerFailureTailDropsPartialLines(t *testing.T) {
	var output devcontainerFailureOutput
	_, _ = output.Write([]byte(strings.Repeat("private-partial-line", 4000)))
	if output.String() != "" {
		t.Fatal("a truncated line could expose a partial secret")
	}
	_, _ = output.Write([]byte("\n{\"text\":\"ERROR: installation failed\"}\n"))
	if output.String() != "{\"text\":\"ERROR: installation failed\"}\n" {
		t.Fatalf("lost the following complete diagnostic: %q", output.String())
	}
}

func TestDevcontainerFailureDiagnosticIsBoundedAndMasksAuthorization(t *testing.T) {
	detail := devcontainerFailureDiagnostic("", strings.Repeat("ERROR: failed 值 ", 500)+
		"\nERROR: Authorization: Bearer owned-authorization", Assignment{})
	if len(detail) > 1024 || !utf8.ValidString(detail) ||
		strings.Contains(detail, "owned-authorization") {
		t.Fatalf("unsafe bounded diagnostic: %q", detail)
	}
}
