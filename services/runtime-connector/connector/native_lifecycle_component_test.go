package connector

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Explicit Docker component proof with the unmodified pinned CLI. No Factory
// project file, custom hook parser, native Actor or paid-model call is involved.
func TestNativeLifecyclePinnedCLIWaitFor(t *testing.T) {
	cli, image := os.Getenv("FACTORY_DEVCONTAINER_CLI"), os.Getenv("FACTORY_LIFECYCLE_COMPONENT_IMAGE")
	if cli == "" || image == "" {
		t.Skip("requires the pinned CLI and an explicitly owned Docker component image")
	}
	if !browserImagePattern.MatchString(image) {
		t.Fatal("component image must be pinned")
	}
	cli, err := filepath.Abs(cli)
	if err != nil {
		t.Fatal(err)
	}
	version, err := exec.Command(cli, "--version").Output()
	if err != nil || strings.TrimSpace(string(version)) != prebuildCLIVersion {
		t.Fatalf("requires pinned CLI %s, got %q: %v", prebuildCLIVersion, version, err)
	}
	for _, waitFor := range []string{"", "postCreateCommand", "postStartCommand"} {
		t.Run("waitFor="+waitFor, func(t *testing.T) {
			docker := func(args ...string) string {
				t.Helper()
				out, err := exec.Command("docker", args...).CombinedOutput()
				if err != nil {
					t.Fatalf("owned Docker component operation failed: %v: %s", err, out)
				}
				return strings.TrimSpace(string(out))
			}
			directory := t.TempDir()
			owner := "factory-lifecycle-" + strings.ToLower(rand.Text())
			const label = "factory.lifecycle-component"
			// Match the native private bridge range; OrbStack's own default
			// allocator may select an unrelated host-specific address range.
			network := docker("network", "create", "--subnet", "172.30.254.0/24", "--label", label+"="+owner, owner)
			t.Cleanup(func() {
				ids := strings.Fields(docker("ps", "-aq", "--no-trunc", "--filter", "label="+label+"="+owner))
				for _, id := range ids {
					if docker("inspect", "--format", `{{index .Config.Labels "`+label+`"}}`, id) != owner {
						t.Error("component container ownership changed")
						continue
					}
					docker("rm", "--force", id)
				}
				if docker("network", "inspect", "--format", `{{index .Labels "`+label+`"}}`, network) != owner {
					t.Error("component network ownership changed")
					return
				}
				docker("network", "rm", network)
			})
			phases := []string{"onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"}
			boundary := 1
			if waitFor == "postCreateCommand" {
				boundary = 2
			} else if waitFor == "postStartCommand" {
				boundary = 3
			}
			config := map[string]any{
				"image": image, "remoteUser": "node", "userEnvProbe": "none",
				"runArgs": []string{"--network=" + owner, "--label=" + label + "=" + owner,
					"--cap-drop=ALL", "--cpus=1", "--memory=256m", "--pids-limit=64"},
			}
			if waitFor != "" {
				config["waitFor"] = waitFor
			}
			for index, phase := range phases {
				hook := "printf '%s\\n' " + phase + " >> /tmp/owned-lifecycle"
				if index == boundary+1 {
					hook = "touch /tmp/owned-setup-held; while [ ! -f /tmp/owned-setup-release ]; do sleep 0.01; done; " + hook
				}
				config[phase] = []string{"/bin/sh", "-c", hook}
			}
			path := filepath.Join(directory, ".devcontainer", "devcontainer.json")
			if err := os.Mkdir(filepath.Dir(path), 0755); err != nil {
				t.Fatal(err)
			}
			content, _ := json.Marshal(config)
			if err := os.WriteFile(path, content, 0644); err != nil {
				t.Fatal(err)
			}
			assignment := Assignment{
				WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
				RuntimeAttemptID: owner, Generation: 1,
			}
			command := exec.CommandContext(t.Context(), cli, "up", "--workspace-folder", directory, "--config", path,
				"--id-label", attemptLabel+"="+owner, "--id-label", generationLabel+"=1",
				"--skip-post-create", "--update-remote-user-uid-default", "never")
			var diagnostic strings.Builder
			command.Stderr = &diagnostic
			output, err := command.Output()
			var result devcontainerResult
			if err != nil || json.Unmarshal(output, &result) != nil || result.Outcome != "success" {
				t.Fatalf("official CLI component startup failed: %v: %s: %s", err, output, diagnostic.String())
			}
			// Production resolves `devcontainer` through PATH as shipped.
			wrapper := filepath.Join(directory, "devcontainer")
			if err := os.Symlink(cli, wrapper); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			result.lifecyclePending, err = runNativeLifecycle(t.Context(), assignment, result, true)
			if err != nil || !result.lifecyclePending {
				t.Fatalf("official CLI did not expose its waitFor boundary: %v", err)
			}
			if got := strings.Fields(docker("exec", result.ContainerID, "cat", "/tmp/owned-lifecycle")); !reflect.DeepEqual(got, phases[:boundary+1]) {
				t.Fatalf("waitFor ran unexpected hooks: %v", got)
			}
			setup := startNativeSetup(t.Context(), assignment, result, nil)
			defer setup.stop()
			for deadline := time.Now().Add(10 * time.Second); ; {
				out, err := exec.Command("docker", "exec", result.ContainerID, "test", "-f", "/tmp/owned-setup-held").CombinedOutput()
				if err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("official CLI did not start its deferred hook: %s", out)
				}
				time.Sleep(10 * time.Millisecond)
			}
			select {
			case <-setup.done:
				t.Fatal("held deferred hook claimed completion")
			default:
			}
			docker("exec", "--user", "node", result.ContainerID, "touch", "/tmp/owned-setup-release")
			select {
			case <-setup.done:
			case <-time.After(10 * time.Second):
				t.Fatal("official CLI continuation did not settle")
			}
			if setup.exit == nil || *setup.exit != 0 {
				t.Fatalf("official CLI continuation failed: %s", setup.output)
			}
			if got := strings.Fields(docker("exec", result.ContainerID, "cat", "/tmp/owned-lifecycle")); !reflect.DeepEqual(got, phases) {
				t.Fatalf("official CLI repeated or omitted lifecycle commands: %v", got)
			}
			saved, err := os.ReadFile(path)
			if err != nil || string(saved) != string(content) {
				t.Fatal("standard project configuration was changed")
			}
		})
	}
}
