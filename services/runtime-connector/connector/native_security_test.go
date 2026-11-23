package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
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
	assignment.nativeActorUID = "owned-native-security"
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
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

func TestNativePrimarySecurityDefaultsPreserveStandardRecipes(t *testing.T) {
	for _, recipe := range []string{"image", "dockerfile", "image-all", "image-partial", "compose", "compose-all", "compose-partial", "prepared-image", "prepared-compose"} {
		t.Run(recipe, func(t *testing.T) {
			assignment := nativeSecurityFixture(t)
			configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
			config := map[string]any{
				"image": "mcr.microsoft.com/devcontainers/python:3.14", "remoteUser": "vscode",
				"postCreateCommand": "python -m pip install -r requirements.txt",
			}
			compose := strings.Contains(recipe, "compose")
			var sourceCompose []byte
			composePath := filepath.Join(filepath.Dir(configPath), "compose.json")
			primary := map[string]any{"image": "mcr.microsoft.com/devcontainers/python:3.14"}
			dependency := map[string]any{"image": "postgres:18", "environment": map[string]string{"PGDATA": "/data"}}
			args := []string{"--init"}
			if strings.HasSuffix(recipe, "-all") {
				args = append(args, "--cap-drop", "ALL")
				primary["cap_drop"] = []string{"ALL"}
			} else if strings.HasSuffix(recipe, "-partial") {
				args = append(args, "--cap-drop=CAP_NET_RAW")
				primary["cap_drop"] = []string{"NET_RAW"}
			}
			if compose {
				delete(config, "image")
				config["dockerComposeFile"], config["service"] = "compose.json", "python"
				sourceCompose = writeNativeSecurityJSON(t, composePath, map[string]any{
					"services": map[string]any{"python": primary, "database": dependency},
				})
			} else if recipe != "image" {
				config["runArgs"] = args
			}
			if recipe == "dockerfile" {
				delete(config, "image")
				config["build"] = map[string]string{"dockerfile": "Dockerfile", "context": ".."}
			}
			source := writeNativeSecurityJSON(t, configPath, config)
			var preparedPath string
			var prepared []byte
			if strings.HasPrefix(recipe, "prepared-") {
				preparedPath = filepath.Join(t.TempDir(), "devcontainer.json")
				if compose {
					imageOverlay := filepath.Join(filepath.Dir(preparedPath), "prepared-compose.json")
					writeNativeSecurityJSON(t, imageOverlay, map[string]any{
						"services": map[string]any{"python": map[string]any{
							"image": projectImage("b"), "build": nil, "pull_policy": "never",
						}},
					})
					config["dockerComposeFile"] = []string{composePath, imageOverlay}
				} else {
					config["image"] = projectImage("b")
				}
				// A prepared consumer's lifecycle decision must survive layering.
				delete(config, "postCreateCommand")
				prepared = writeNativeSecurityJSON(t, preparedPath, config)
				assignment.EffectiveConfiguration = preparedPath
			}
			path, cleanup, err := prepareNativeSecurity(t.Context(), assignment)
			defer cleanup()
			if err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(path)
			var effective map[string]json.RawMessage
			if err != nil || json.Unmarshal(content, &effective) != nil {
				t.Fatal("private effective configuration is unavailable", err)
			}
			for key, value := range config {
				if key == "runArgs" || key == "dockerComposeFile" {
					continue
				}
				want, _ := json.Marshal(value)
				if string(effective[key]) != string(want) {
					t.Fatalf("security preparation changed %s: %s", key, effective[key])
				}
			}
			if compose {
				var files []string
				if json.Unmarshal(effective["dockerComposeFile"], &files) != nil || files[0] != composePath {
					t.Fatal("Compose relative-path base changed")
				}
				arguments := []string{"compose"}
				for _, file := range files {
					arguments = append(arguments, "--file", file)
				}
				output, err := runtimeDockerCommand(t.Context(), append(arguments, "config", "--format", "json")...).Output()
				var model struct {
					Services map[string]map[string]any `json:"services"`
				}
				if err != nil || json.Unmarshal(output, &model) != nil {
					t.Fatal("effective Compose model is unavailable", err)
				}
				actualDependency, _ := json.Marshal(model.Services["database"])
				expectedDependency, _ := json.Marshal(dependency)
				if string(actualDependency) != string(expectedDependency) {
					t.Fatal("security defaults changed a dependency service", err)
				}
				var declaration any
				_ = json.Unmarshal(effective["dockerComposeFile"], &declaration)
				if _, err := validateCompose(t.Context(), assignment, configPath, declaration, "python", nil); err != nil {
					t.Fatal("generated Compose restrictions failed normal pre-up validation", err)
				}
				if recipe == "compose-all" && len(files) != 1 {
					t.Fatal("explicit stronger ALL unnecessarily acquired an override")
				}
				if preparedPath != "" && (len(files) != 3 || model.Services["python"]["image"] != projectImage("b") ||
					model.Services["python"]["pull_policy"] != "never") {
					t.Fatal("security defaults lost the prepared primary override")
				}
			} else {
				var actual []string
				if json.Unmarshal(effective["runArgs"], &actual) != nil {
					t.Fatal("effective image run arguments are unavailable")
				}
				expected := append([]string(nil), args...)
				if recipe == "image" {
					expected = nil
				}
				if recipe != "image-all" {
					if recipe != "image-partial" {
						expected = append(expected, "--cap-drop=NET_RAW")
					}
					expected = append(expected, "--cap-drop=SYS_PTRACE")
				}
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("authored/required run arguments changed: %v, want %v", actual, expected)
				}
				// The inspected boundary is deliberately still fail-closed.
				container := inspectedContainer{}
				container.HostConfig.CapDrop = []string{"NET_RAW", "SYS_PTRACE"}
				if err := validateContainerBoundary(container, assignment); err != nil {
					t.Fatal(err)
				}
			}
			if got, _ := os.ReadFile(configPath); string(got) != string(source) {
				t.Fatal("the user's Dev Container file was rewritten")
			}
			if compose {
				if got, _ := os.ReadFile(composePath); string(got) != string(sourceCompose) {
					t.Fatal("the user's Compose file was rewritten")
				}
			}
			if preparedPath != "" {
				if got, _ := os.ReadFile(preparedPath); string(got) != string(prepared) {
					t.Fatal("the existing prepared override was rewritten")
				}
				if effective["postCreateCommand"] != nil {
					t.Fatal("security preparation replayed a removed prepared hook")
				}
			}
			cleanup()
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("private security configuration survived cleanup")
			}
		})
	}
}

func TestNativeSecurityDefaultsDoNotAdmitForbiddenComposeSettings(t *testing.T) {
	for name, forbidden := range map[string]map[string]any{
		"cap-add":     {"cap_add": []string{"NET_RAW"}},
		"unconfined":  {"security_opt": []string{"seccomp=unconfined"}},
		"host-net":    {"network_mode": "host"},
		"host-socket": {"volumes": []any{map[string]any{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}}},
	} {
		t.Run(name, func(t *testing.T) {
			assignment := nativeSecurityFixture(t)
			configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
			writeNativeSecurityJSON(t, configPath, map[string]any{"dockerComposeFile": "compose.json", "service": "python"})
			forbidden["image"] = "mcr.microsoft.com/devcontainers/python:3.14"
			writeNativeSecurityJSON(t, filepath.Join(filepath.Dir(configPath), "compose.json"), map[string]any{
				"services": map[string]any{"python": forbidden},
			})
			path, cleanup, err := prepareNativeSecurity(t.Context(), assignment)
			defer cleanup()
			if err != nil {
				t.Fatal(err)
			}
			content, _ := os.ReadFile(path)
			var effective struct {
				Files any `json:"dockerComposeFile"`
			}
			if err := json.Unmarshal(content, &effective); err != nil {
				t.Fatal(err)
			}
			if _, err := validateCompose(t.Context(), assignment, configPath, effective.Files, "python", nil); err == nil {
				t.Fatal("adding required drops concealed a forbidden Project setting")
			}
		})
	}
}

func TestNativeStandardRecipesWithoutDropsRemainConfined(t *testing.T) {
	assignment := nativeSecurityFixture(t)
	t.Run("standard-image-before-defaults", func(t *testing.T) {
		if err := validateContainerBoundary(inspectedContainer{}, assignment); err == nil {
			t.Fatal("an unhardened primary was accepted")
		} else {
			t.Log("standard image before generated defaults:", err)
		}
	})
	t.Run("standard-compose-before-defaults", func(t *testing.T) {
		compose := filepath.Join(assignment.WorkspaceFolder, ".devcontainer", "compose.json")
		if err := os.WriteFile(compose, []byte(`{"services":{"python":{"image":"mcr.microsoft.com/devcontainers/python:3.14"}}}`), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := validateCompose(context.Background(), assignment,
			filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath), "compose.json", "python", nil)
		if err == nil || !strings.Contains(err.Error(), "must drop NET_RAW and SYS_PTRACE") {
			t.Fatalf("standard Compose did not reproduce its missing-drop refusal: %v", err)
		}
		t.Log("standard Compose before generated defaults:", err)
	})
}
