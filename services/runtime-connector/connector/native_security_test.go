package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// Keep this Go-only so the same fixture runs in the pinned Linux Go image.
func TestNativeSecurityCommandProcess(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_SECURITY_TEST_PROCESS") != "1" {
		return
	}
	index := slices.Index(os.Args, "--")
	if index == -1 || index+1 == len(os.Args) {
		os.Exit(9)
	}
	args := os.Args[index+1:]
	read := func(path string) map[string]any {
		content, err := os.ReadFile(path)
		var value map[string]any
		if err != nil || json.Unmarshal(content, &value) != nil {
			os.Exit(9)
		}
		return value
	}
	var result any
	switch args[0] {
	case "read-configuration":
		flag := "--config"
		if slices.Contains(args, "--override-config") {
			flag = "--override-config"
		}
		position := slices.Index(args, flag)
		if position == -1 || position+1 == len(args) {
			os.Exit(9)
		}
		config := read(args[position+1])
		result = map[string]any{"configuration": config, "mergedConfiguration": config}
	case "compose":
		services := map[string]any{}
		for i := 1; i < len(args); i++ {
			if args[i] != "--file" && args[i] != "-f" {
				continue
			}
			i++
			for name, value := range read(args[i])["services"].(map[string]any) {
				service := value.(map[string]any)
				prior, ok := services[name].(map[string]any)
				if !ok {
					prior = map[string]any{}
				}
				for key, field := range service {
					if key == "cap_drop" {
						drops, _ := prior[key].([]any)
						for _, drop := range field.([]any) {
							if !slices.Contains(drops, drop) {
								drops = append(drops, drop)
							}
						}
						prior[key] = drops
					} else {
						prior[key] = field
					}
				}
				services[name] = prior
			}
		}
		result = map[string]any{"services": services}
	default:
		os.Exit(9)
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(9)
	}
	os.Exit(0)
}

func nativeSecurityFixture(t *testing.T) Assignment {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, ".devcontainer", "devcontainer.json")
	if err := os.Mkdir(filepath.Dir(config), 0700); err != nil {
		t.Fatal(err)
	}
	tools := t.TempDir()
	script := `#!/bin/sh
# This synchronous command fixture has no background work to drain at exit.
GORACE="${GORACE:+$GORACE }atexit_sleep_ms=0"
export GORACE
exec "$FACTORY_NATIVE_SECURITY_TEST_EXECUTABLE" -test.run='^TestNativeSecurityCommandProcess$' -- "$@"
`
	t.Setenv("FACTORY_NATIVE_SECURITY_TEST_PROCESS", "1")
	t.Setenv("FACTORY_NATIVE_SECURITY_TEST_EXECUTABLE", os.Args[0])
	for _, name := range []string{"devcontainer", "docker"} {
		if err := os.WriteFile(filepath.Join(tools, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	assignment := validAssignment()
	assignment.WorkspaceFolder = root
	assignment.SetNativeActorUID("owned-native-security")
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.NativeActorUID())
	return assignment
}

func writeNativeSecurityJSON(t *testing.T, path string, value any) []byte {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	return content
}
