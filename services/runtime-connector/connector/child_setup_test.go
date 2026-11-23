package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestChildSetupUsesRootButRunsConnectorAsRemoteUser(t *testing.T) {
	for _, kind := range []string{"app", "ide", "agent", "verification"} {
		t.Run(kind, func(t *testing.T) {
			directory := t.TempDir()
			directory, err := filepath.EvalSymlinks(directory)
			if err != nil {
				t.Fatal(err)
			}
			fixturePrebuildTools(t, filepath.Join(directory, "opencode"))
			logPath := filepath.Join(directory, "docker.log")
			started := filepath.Join(directory, "child-started")
			captured := filepath.Join(directory, "child-assignment.json")
			// Docker cp creates root-owned files even when the image declares
			// USER node. Only the explicit administrative exec may prepare them.
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
case "$1" in
  cp)
    case "$3" in *:/tmp/factory-runtime-assignment-*.json)
      cp "$2" "$FACTORY_CAPTURED_ASSIGNMENT" || exit 1 ;;
    esac
    exit 0 ;;
  exec)
    case "$*" in *opencode-verify*) cat >/dev/null; exit 0 ;; esac
    case "$*" in *"tar --no-same-owner -xf - -C "*)
      test "$2" = --interactive && test "$3" = --user && test "$4" = 0:0 || exit 1
      cat >/dev/null
      exit 0 ;;
    esac
    if [ "$2" = --interactive ]; then
      test "$3" = --user && test "$4" = "$FACTORY_CHILD_REMOTE_USER" || exit 1
      cat >/dev/null
      printf started > "$FACTORY_CHILD_STARTED"
      exit 0
    fi
    case "$*" in *"ldd --version"*) printf 'musl\n'; exit 0 ;; esac
    if [ "$2" != --user ] || [ "$3" != 0:0 ]; then
      printf 'Operation not permitted for image USER node\n' >&2
      exit 1
    fi ;;
  *) exit 1 ;;
esac
`
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, "tar"), []byte("#!/bin/sh\nprintf 'owned archive fixture'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_DOCKER_LOG", logPath)
			t.Setenv("FACTORY_CHILD_STARTED", started)
			t.Setenv("FACTORY_CAPTURED_ASSIGNMENT", captured)
			assignment := validAssignment()
			assignment.Channels = []Channel{{Name: kind, Kind: kind}}
			remote := "/workspace/project"
			remoteUser := "node"
			checkout := remote
			if kind == "app" {
				remote = "/workspaces/project"
				checkout = remote
				remoteUser = "vscode"
			} else if kind == "ide" {
				remote = "/development/python-project"
				checkout = remote
				remoteUser = "1001:1002"
			} else if kind == "agent" {
				checkout = "/workspaces/project"
				remote = checkout + "/services/api"
			}
			t.Setenv("FACTORY_CHILD_REMOTE_USER", remoteUser)
			stop, err := injectChild(context.WithValue(context.Background(), openCodeArtifactsRootKey{}, filepath.Join(directory, "opencode")), assignment, devcontainerResult{
				ContainerID:           "owned-child",
				RemoteUser:            remoteUser,
				RemoteWorkspaceFolder: remote,
				checkoutFolder:        checkout,
			}, "private-child-token")
			t.Cleanup(stop)
			if err != nil {
				t.Fatal("non-root Dev Container could not receive its Connector and approved tools", err)
			}
			for deadline := time.Now().Add(2 * time.Second); ; {
				if _, err := os.Stat(started); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("Connector child did not run as its intended remote user")
				}
				time.Sleep(time.Millisecond)
			}
			// Decode what Parent actually copied, not just its in-memory helper.
			data, err := os.ReadFile(captured)
			if err != nil {
				t.Fatal(err)
			}
			var child Assignment
			if err := json.Unmarshal(data, &child); err != nil {
				t.Fatal(err)
			}
			if child.WorkspaceFolder != remote || child.RemoteWorkspaceFolder != remote || child.CheckoutFolder != checkout ||
				child.RuntimeAttemptID != assignment.RuntimeAttemptID || child.Generation != assignment.Generation ||
				assignment.WorkspaceFolder != "/workspace/outer" || assignment.RemoteWorkspaceFolder != "/workspace/project" {
				t.Fatalf("copied Child cwd or canonical Parent identity changed: %#v", child)
			}
			data, err = os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			commands := string(data)
			if !strings.Contains(commands, "exec --user 0:0 owned-child sh -c chmod 0555") ||
				!strings.Contains(commands, "exec --interactive --user "+remoteUser+" owned-child") ||
				strings.Contains(commands, "private-child-token") {
				t.Fatal("setup changed execution authority or exposed credentials", commands)
			}
		})
	}
}
