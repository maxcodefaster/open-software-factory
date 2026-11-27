package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeWorkspaceFolderAssignment(directory string) Assignment {
	assignment := Assignment{
		RuntimeAttemptID: "owned-attempt", Generation: 1,
		WorkspaceFolder: directory, ActorTemplatePath: ".devcontainer/devcontainer.json",
		RemoteWorkspaceFolder: "/workspace/project",
		RepositoryIdentity:    "owned-python-project", Revision: strings.Repeat("c", 40),
		Channels: []Channel{{Name: "ide", Kind: "ide"}, {Name: "app", Kind: "app"}},
	}
	assignment.SetNativeActorUID("owned-actor")
	return assignment
}

func rewriteWorkspaceMount(t *testing.T, directory string, change func(map[string]any)) {
	t.Helper()
	path := filepath.Join(directory, "primary")
	content, err := os.ReadFile(path)
	var primary []map[string]any
	if err != nil || json.Unmarshal(content, &primary) != nil || len(primary) != 1 {
		t.Fatal("primary inspection fixture is unavailable", err)
	}
	change(primary[0])
	content, err = json.Marshal(primary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}
