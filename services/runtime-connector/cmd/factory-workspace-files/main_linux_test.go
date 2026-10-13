package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceCommandRejectsInvalidInitializationBeforeServing(t *testing.T) {
	if encoded := os.Getenv("FACTORY_SOURCE_COMMAND_CHILD"); encoded != "" {
		var args []string
		if err := json.Unmarshal([]byte(encoded), &args); err != nil {
			t.Fatal(err)
		}
		os.Args = append([]string{"factory-workspace-files"}, args...)
		main()
		return
	}
	parent := t.TempDir()
	access := filepath.Join(parent, "access.json")
	initialization := filepath.Join(parent, "initialize.json")
	if err := os.WriteFile(access, []byte(`{"workspaceId":"workspace-a","serviceId":"source-a","epoch":1,"token":"01234567890123456789012345678901"}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name, content, root, want string
	}{
		{"unknown field", `{"workspaceId":"workspace-a","unexpected":true}`, parent + "/project", "invalid source initialization assignment"},
		{"different workspace", `{"workspaceId":"workspace-b"}`, parent + "/project", "source initialization identity differs"},
		{"trailing JSON", `{"workspaceId":"workspace-a"} {}`, parent + "/project", "source initialization identity differs"},
		{"oversized", strings.Repeat(" ", 8193), parent + "/project", "invalid source initialization assignment"},
		{"wrong mount", `{}`, parent + "/other", "invalid combined source initialization"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if err := os.WriteFile(initialization, []byte(scenario.content), 0600); err != nil {
				t.Fatal(err)
			}
			args, _ := json.Marshal([]string{"--root", scenario.root, "--parent", parent, "--assignment", access, "--initialize", initialization, "--listen", "invalid-listener"})
			command := exec.Command(os.Args[0], "-test.run=^TestSourceCommandRejectsInvalidInitializationBeforeServing$")
			command.Env = append(os.Environ(), "FACTORY_SOURCE_COMMAND_CHILD="+string(args))
			output, err := command.CombinedOutput()
			if err == nil || !strings.Contains(string(output), scenario.want) || strings.Contains(string(output), "could not listen") {
				t.Fatalf("invalid assignment reached serving: %s %v", output, err)
			}
			if _, err := os.Stat(filepath.Join(parent, "project")); !os.IsNotExist(err) {
				t.Fatal("invalid assignment initialized a checkout")
			}
		})
	}
}
