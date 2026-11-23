package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Exercise the real Factory startup call site against the pinned CLI's container
// metadata resolver. Docker observations are local fixtures, never a daemon.
// read-configuration uses the same container/config/identity resolution as
// run-user-commands and exposes the exact ordered commands before execution.
func TestNativeLifecyclePinnedCLIMetadataExactlyOnce(t *testing.T) {
	cli := os.Getenv("FACTORY_DEVCONTAINER_CLI")
	if cli == "" {
		t.Skip("set FACTORY_DEVCONTAINER_CLI to the official pinned CLI executable")
	}
	cli, err := filepath.Abs(cli)
	if err != nil {
		t.Fatal(err)
	}
	version, err := exec.Command(cli, "--version").Output()
	if err != nil || strings.TrimSpace(string(version)) != prebuildCLIVersion {
		t.Fatalf("requires pinned CLI %s, got %q: %v", prebuildCLIVersion, version, err)
	}
	for _, recipe := range []string{"dockerfile-feature", "compose-feature", "image-without-metadata", "prebuilt-override", "native-dependency-override"} {
		t.Run(recipe, func(t *testing.T) {
			directory := nativeNetworkFixture(t)
			project := map[string]any{
				"workspaceFolder": "/workspace/project", "remoteUser": "node",
				"onCreateCommand":      []string{"node", "hook.mjs", "onCreate"},
				"updateContentCommand": []string{"node", "hook.mjs", "updateContent"},
				"postCreateCommand":    "node hook.mjs postCreate",
				"postStartCommand":     map[string]any{"project": []string{"node", "hook.mjs", "postStart"}},
				"postAttachCommand":    "node hook.mjs postAttach",
				"remoteEnv":            map[string]string{"PROJECT_VALUE": "preserved"},
			}
			switch recipe {
			case "dockerfile-feature":
				project["build"] = map[string]string{"dockerfile": "Dockerfile"}
				project["features"] = map[string]any{"./feature": map[string]any{}}
			case "compose-feature":
				project["dockerComposeFile"], project["service"] = "compose.json", "workspace"
				project["features"] = map[string]any{"./feature": map[string]any{}}
			default:
				project["image"] = "owned-image"
			}
			configPath := filepath.Join(directory, ".devcontainer", "devcontainer.json")
			if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
				t.Fatal(err)
			}
			writeJSON := func(path string, value any) {
				t.Helper()
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			writeJSON(configPath, project)
			// A built primary already contains inherited, Feature and Project
			// metadata. Equal Feature and Project commands must NOT be deduplicated.
			metadata := []any{
				map[string]any{"onCreateCommand": "inherited-create"},
				map[string]any{"id": "./feature", "postCreateCommand": project["postCreateCommand"]},
				project,
			}
			var primary []map[string]any
			original, _ := os.ReadFile(filepath.Join(directory, "primary"))
			if err := json.Unmarshal(original, &primary); err != nil {
				t.Fatal(err)
			}
			primary[0]["NetworkSettings"] = map[string]any{"Ports": map[string]any{}}
			primary[0]["Mounts"] = []map[string]any{{
				"Type": "bind", "Source": directory, "Destination": "/workspace/project", "RW": true,
			}}
			primary[0]["Config"].(map[string]any)["Env"] = []string{"PATH=/usr/bin:/bin"}
			labels := primary[0]["Config"].(map[string]any)["Labels"].(map[string]any)
			if recipe != "image-without-metadata" {
				encoded, _ := json.Marshal(metadata)
				labels["devcontainer.metadata"] = string(encoded)
			}
			writeJSON(filepath.Join(directory, "primary"), primary)
			assignment := Assignment{
				RuntimeAttemptID: "owned-attempt", Generation: 1, ComposeProjectName: "owned",
				WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
				RemoteWorkspaceFolder: "/workspace/project", nativeActorUID: "owned-actor",
			}
			if recipe == "prebuilt-override" || recipe == "native-dependency-override" {
				overlay := make(map[string]any, len(project))
				for key, value := range project {
					overlay[key] = value
				}
				if recipe == "prebuilt-override" {
					for _, hook := range []string{"onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"} {
						delete(overlay, hook)
					}
				}
				assignment.EffectiveConfiguration = filepath.Join(directory, "devcontainer.json")
				writeJSON(assignment.EffectiveConfiguration, overlay)
			}
			if err := os.Rename(filepath.Join(directory, "devcontainer"), filepath.Join(directory, "fixture-cli")); err != nil {
				t.Fatal(err)
			}
			// Forward actual production arguments to the unmodified official
			// resolver. Only execution-only options are omitted from this read.
			script := fmt.Sprintf(`#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const root = %q, cli = %q, args = process.argv.slice(2);
if (args[0] !== 'run-user-commands') {
  const result = cp.spawnSync(root + '/fixture-cli', args, {stdio:'inherit'});
  process.exit(result.status ?? 1);
}
fs.appendFileSync(root + '/cli.log', args.join(' ') + '\n');
const read = ['read-configuration'];
for (let i=1; i<args.length; i++) {
  if (args[i] === '--remote-env' || args[i] === '--secrets-file') { i++; continue; }
  if (args[i] === '--oci-auth-hardening') continue;
  read.push(args[i]);
}
read.push('--include-merged-configuration', '--log-level', 'trace');
const result = cp.spawnSync(cli, read, {encoding:'utf8'});
if (result.status !== 0) {
  fs.writeFileSync(root + '/read-failure.json', JSON.stringify(result));
  process.stderr.write(result.stdout + result.stderr + String(result.error || ''));
  process.exit(1);
}
fs.writeFileSync(root + '/resolved.json', result.stdout);
console.log('{"outcome":"success"}');
`, directory, cli)
			if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			// This portable fixture qualifies lifecycle metadata resolution,
			// not Linux checkout ownership or pre-up lockfile admission.
			if _, err := startDevcontainerWithConfiguration(context.Background(), assignment,
				func(context.Context, Assignment, bool) ([]string, error) { return nil, nil }); err != nil {
				result, _ := os.ReadFile(filepath.Join(directory, "read-failure.json"))
				trace, _ := os.ReadFile(filepath.Join(directory, "docker.log"))
				t.Fatalf("%v\nresolver: %s\ndocker: %s", err, result, trace)
			}
			var resolved struct {
				Merged map[string]any `json:"mergedConfiguration"`
			}
			data, err := os.ReadFile(filepath.Join(directory, "resolved.json"))
			if err != nil || json.Unmarshal(data, &resolved) != nil {
				t.Fatalf("CLI resolution unavailable: %s: %v", data, err)
			}
			for _, phase := range []string{"onCreate", "updateContent", "postCreate", "postStart", "postAttach"} {
				expected := []any{project[phase+"Command"]}
				if recipe != "image-without-metadata" && phase == "onCreate" {
					expected = append([]any{"inherited-create"}, expected...)
				}
				if recipe != "image-without-metadata" && phase == "postCreate" {
					expected = append([]any{project[phase+"Command"]}, expected...)
				}
				// Normalize authored array and object Go values to JSON values.
				encoded, _ := json.Marshal(expected)
				var want any
				_ = json.Unmarshal(encoded, &want)
				got := resolved.Merged[phase+"Commands"]
				if !reflect.DeepEqual(got, want) {
					actual, _ := json.Marshal(got)
					t.Errorf("%s lifecycle commands repeated or lost: got %s, want %s", phase, actual, encoded)
				}
			}
			if got := resolved.Merged["remoteEnv"]; !reflect.DeepEqual(got, map[string]any{"PROJECT_VALUE": "preserved"}) {
				t.Errorf("Project remote environment changed: %v", got)
			}
			trace, _ := os.ReadFile(filepath.Join(directory, "cli.log"))
			if strings.Count(string(trace), "run-user-commands ") != 1 {
				t.Fatalf("lifecycle dispatch was not singular: %s", trace)
			}
		})
	}
}
