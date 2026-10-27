package connector

import (
	"context"
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
			logPath := filepath.Join(directory, "docker.log")
			started := filepath.Join(directory, "child-started")
			// Docker cp creates root-owned files even when the image declares
			// USER node. Only the explicit administrative exec may prepare them.
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
case "$1" in
  cp) exit 0 ;;
  exec)
    if [ "$2" = --interactive ]; then
      test "$3" = --user && test "$4" = node || exit 1
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
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_DOCKER_LOG", logPath)
			t.Setenv("FACTORY_CHILD_STARTED", started)
			assignment := validAssignment()
			assignment.Channels = []Channel{{Name: kind, Kind: kind}}
			err := injectChild(context.Background(), assignment, devcontainerResult{
				ContainerID:           "owned-child",
				RemoteUser:            "node",
				RemoteWorkspaceFolder: "/workspace/project",
			}, "private-child-token")
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
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			commands := string(data)
			if !strings.Contains(commands, "exec --user 0:0 owned-child sh -c chmod 0555") ||
				!strings.Contains(commands, "exec --interactive --user node owned-child") ||
				strings.Contains(commands, "private-child-token") {
				t.Fatal("setup changed execution authority or exposed credentials", commands)
			}
		})
	}
}
