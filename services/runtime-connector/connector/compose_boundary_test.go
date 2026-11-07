package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestComposeValidationRefusesHostBoundariesAndForeignFiles(t *testing.T) {
	root := t.TempDir()
	config := filepath.Join(root, ".devcontainer", "devcontainer.json")
	inside := filepath.Join(root, "token.txt")
	if err := os.WriteFile(inside, []byte("project secret"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	validate := func(document string) error {
		script := "#!/bin/sh\ncat <<'EOF'\n" + document + "\nEOF\n"
		if err := os.WriteFile(filepath.Join(root, "docker"), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		_, err := validateCompose(context.Background(), Assignment{WorkspaceFolder: root}, config,
			"compose.json", "workspace", nil)
		return err
	}
	service := func(extra string) string {
		return `{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]` + extra + `}}}`
	}
	if err := validate(service(`,"ipc":"shareable","volumes_from":["service:other"]`)); err != nil {
		t.Fatalf("rejected a Compose project inside its boundary: %v", err)
	}
	if err := validate(`{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}},` +
		`"secrets":{"token":{"file":"` + inside + `"}}}`); err != nil {
		t.Fatalf("rejected a secret file inside the checkout: %v", err)
	}
	for name, document := range map[string]string{
		"host ipc":       service(`,"ipc":"host"`),
		"host uts":       service(`,"uts":"host"`),
		"host cgroup":    service(`,"cgroup":"host"`),
		"host userns":    service(`,"userns_mode":"host"`),
		"devices":        service(`,"devices":["/dev/fuse:/dev/fuse"]`),
		"foreign volume": service(`,"volumes_from":["container:other"]`),
		"foreign secret": `{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}},` +
			`"secrets":{"token":{"file":"/etc/hosts"}}}`,
		"foreign config": `{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}},` +
			`"configs":{"token":{"file":"/etc/hosts"}}}`,
	} {
		if err := validate(document); err == nil {
			t.Fatalf("accepted a Compose project with %s", name)
		}
	}
}

func TestInitializeCommandIsRecognizedInEveryForm(t *testing.T) {
	for raw, want := range map[string]bool{
		``:                        false,
		`null`:                    false,
		`""`:                      false,
		`[]`:                      false,
		`{}`:                      false,
		` "npm run prepare" `:     true,
		`["npm","run","prepare"]`: true,
		`{"a":"echo a"}`:          true,
	} {
		if got := hasInitializeCommand(json.RawMessage(raw)); got != want {
			t.Errorf("initializeCommand %q: got %v want %v", raw, got, want)
		}
	}
}
