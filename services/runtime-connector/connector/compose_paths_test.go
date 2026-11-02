package connector

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComposeValidationPreservesAbsoluteFilesAndResolvesRelativeFiles(t *testing.T) {
	root := t.TempDir()
	log := filepath.Join(root, "arguments")
	absolute := filepath.Join(root, "absolute-compose.json")
	config := filepath.Join(root, ".devcontainer", "devcontainer.json")
	docker := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$@" > %q
printf '%%s\n' '{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}}}'
`, log)
	if err := os.WriteFile(filepath.Join(root, "docker"), []byte(docker), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := validateCompose(context.Background(), Assignment{WorkspaceFolder: root}, config,
		[]any{absolute, "relative-compose.json"}, "workspace", nil)
	if err != nil {
		t.Fatal(err)
	}
	arguments, err := os.ReadFile(log)
	expected := "compose\n--file\n" + absolute + "\n--file\n" +
		filepath.Join(root, ".devcontainer", "relative-compose.json") + "\n"
	if err != nil || !strings.HasPrefix(string(arguments), expected) {
		t.Fatalf("Compose file identities changed before validation: %s: %v", arguments, err)
	}
}
