package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStandalonePrimaryRetainsNativeIdentityForBrowserAndCleanup(t *testing.T) {
	directory := t.TempDir()
	id := strings.Repeat("a", 64)
	docker := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_PRIMARY_LOG"
case "$1" in
 ps) exit 0 ;;
 inspect) printf '[{"Id":"%s","State":{"Running":true},"Config":{"Labels":{"factory.dev/runtime-attempt":"owned-attempt","factory.dev/runtime-generation":"4"}},"HostConfig":{"CapDrop":["ALL"]}}]' "$FACTORY_PRIMARY_ID" ;;
 rm) exit 0 ;;
 *) exit 1 ;;
esac
`
	cli := `#!/bin/sh
printf '{"outcome":"success","containerId":"%s","remoteUser":"node","remoteWorkspaceFolder":"/workspace/project"}\n' "$FACTORY_PRIMARY_ID"
`
	for name, content := range map[string]string{"docker": docker, "devcontainer": cli} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_PRIMARY_ID", id)
	logPath := filepath.Join(directory, "commands")
	t.Setenv("FACTORY_PRIMARY_LOG", logPath)
	assignment := Assignment{
		RuntimeAttemptID: "owned-attempt", Generation: 4, ComposeProjectName: "logical_workspace",
		WorkspaceFolder: directory, RemoteWorkspaceFolder: "/workspace/project",
		DevcontainerPath: ".devcontainer/devcontainer.json",
	}
	result, err := startDevcontainer(context.Background(), assignment)
	if err != nil {
		t.Fatal(err)
	}
	if result.ComposeProjectName != "" {
		t.Fatalf("standalone primary acquired a fabricated Compose identity: %q", result.ComposeProjectName)
	}
	origin := containerOrigin{assignment.RuntimeAttemptID, assignment.Generation, result.ComposeProjectName}
	assignment.containerOrigin = &origin
	manager := newBrowserRuntimeManager(context.Background(), assignment, result.ContainerID, result.RemoteUser)
	primary, err := inspectContainer(id)
	if err != nil {
		t.Fatal(err)
	}
	manager.docker = func(context.Context, ...string) ([]byte, error) {
		return json.Marshal([]inspectedContainer{primary})
	}
	if _, err := manager.inspectPrimary(context.Background()); err != nil {
		t.Fatal("browser rejected the admitted standalone primary", err)
	}
	for _, changed := range []string{"id", "attempt", "generation", "compose", "stopped"} {
		t.Run(changed, func(t *testing.T) {
			original := primary
			original.Config.Labels = map[string]string{
				attemptLabel: "owned-attempt", generationLabel: "4",
			}
			primary = original
			switch changed {
			case "id":
				primary.ID = strings.Repeat("b", 64)
			case "attempt":
				primary.Config.Labels[attemptLabel] = "foreign-attempt"
			case "generation":
				primary.Config.Labels[generationLabel] = "5"
			case "compose":
				primary.Config.Labels["com.docker.compose.project"] = "foreign_project"
			case "stopped":
				primary.State.Running = false
			}
			if _, err := manager.inspectPrimary(context.Background()); err == nil {
				t.Fatal("browser accepted changed primary ownership")
			}
			primary = original
		})
	}
	if err := os.WriteFile(logPath, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := cleanupProject(parentState{
		RuntimeAttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation,
		ContainerID: id, ComposeProjectName: assignment.ComposeProjectName, ContainerOrigin: &origin,
	}); err != nil {
		t.Fatal(err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil || string(commands) != "inspect "+id+"\nrm -f "+id+"\n" {
		t.Fatalf("standalone cleanup selected resources outside its exact primary: %s, %v", commands, err)
	}
}
