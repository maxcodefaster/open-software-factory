package connector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrivateDockerReadinessRetriesAndHonorsCancellation(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "commands")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
if [ "$FACTORY_DOCKER_WAIT" = blocked ]; then exec sleep 60; fi
if [ ! -f "$FACTORY_DOCKER_LOG.retry" ]; then touch "$FACTORY_DOCKER_LOG.retry"; exit 1; fi
exit 0
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_DOCKER_LOG", logPath)
	if err := waitForDocker(context.Background()); err != nil {
		t.Fatal(err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil || strings.Count(string(commands), "info --format {{.ServerVersion}}") != 2 {
		t.Fatalf("readiness did not confirm Docker after retry: %s, %v", commands, err)
	}
	t.Setenv("FACTORY_DOCKER_WAIT", "blocked")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := waitForDocker(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked Docker readiness ignored cancellation: %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("blocked Docker readiness did not stop promptly")
	}
}

func TestInteractiveRuntimeInjectsNoEditor(t *testing.T) {
	for _, libc := range []string{"musl", "glibc"} {
		t.Run(libc, func(t *testing.T) {
			directory := t.TempDir()
			log := filepath.Join(directory, "commands")
			script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FACTORY_DOCKER_LOG\"\ncase \"$*\" in *'ldd --version'*) printf '%s\\n' \"$FACTORY_LIBC\";; esac\n"
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_DOCKER_LOG", log)
			t.Setenv("FACTORY_LIBC", libc)
			assignment := validAssignment()
			assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}}
			if err := injectApprovedTools(context.Background(), assignment, "owned-container"); err != nil {
				t.Fatal(err)
			}
			commands, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			actual := string(commands)
			if strings.Contains(actual, "theia") || strings.Contains(actual, "opencode") || strings.Contains(actual, "forgejo") ||
				!strings.Contains(actual, "cp /opt/factory/language-tools/node_modules owned-container:/opt/factory/language-tools/node_modules") ||
				!strings.Contains(actual, "cp /opt/factory/language-tools/"+libc+"/. owned-container:/opt/factory/language-tools/runtime") ||
				strings.Count(strings.TrimSpace(actual), "\n") != 3 {
				t.Fatalf("unexpected interactive injection: %s", actual)
			}
		})
	}
}

func TestBrowserImageStartupChecksExactDigestAndPullsBeforeReadiness(t *testing.T) {
	reference := "registry.factory/browser-tools@sha256:" + strings.Repeat("a", 64)
	for _, scenario := range []string{"cached", "cold", "wrong-digest", "pull-failed", "unconfirmed-pull", "cancelled", "disabled"} {
		t.Run(scenario, func(t *testing.T) {
			directory := t.TempDir()
			logPath := filepath.Join(directory, "commands")
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
case "$1 $2" in
  "image inspect")
    if [ "$FACTORY_IMAGE_SCENARIO" = wrong-digest ]; then printf '["registry.factory/browser-tools@sha256:bad"]'; exit 0; fi
    if [ "$FACTORY_IMAGE_SCENARIO" = cached ] || [ -f "$FACTORY_DOCKER_LOG.pulled" ]; then printf '["%s"]' "$FACTORY_IMAGE_REFERENCE"; exit 0; fi
    exit 1 ;;
  "pull "*)
    if [ "$FACTORY_IMAGE_SCENARIO" = pull-failed ]; then echo 'x509: unknown authority secret-do-not-publish' >&2; exit 1; fi
    if [ "$FACTORY_IMAGE_SCENARIO" != unconfirmed-pull ]; then touch "$FACTORY_DOCKER_LOG.pulled"; fi ;;
  *) exit 1 ;;
esac
`
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_DOCKER_LOG", logPath)
			t.Setenv("FACTORY_IMAGE_SCENARIO", scenario)
			t.Setenv("FACTORY_IMAGE_REFERENCE", reference)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			}
			image := reference
			if scenario == "disabled" {
				image = ""
			}
			err := ensureBrowserImage(ctx, image)
			wantFailure := scenario == "wrong-digest" || scenario == "pull-failed" || scenario == "unconfirmed-pull" || scenario == "cancelled"
			if (err != nil) != wantFailure {
				t.Fatalf("startup error: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "secret-do-not-publish") {
				t.Fatal("published raw Docker diagnostics")
			}
			commands, _ := os.ReadFile(logPath)
			pulled := strings.Contains(string(commands), "pull "+reference)
			if pulled != (scenario == "cold" || scenario == "wrong-digest" || scenario == "pull-failed" || scenario == "unconfirmed-pull") {
				t.Fatalf("unexpected pull: %s", commands)
			}
			if scenario == "cold" && strings.Count(string(commands), "image inspect") != 2 {
				t.Fatalf("pull digest was not confirmed: %s", commands)
			}
		})
	}
}

func TestRunArgumentBoundaryVariants(t *testing.T) {
	for _, arguments := range [][]string{{"--pid", "host"}, {"--pid=host"}, {"--net", "host"}, {"--network=host"}, {"--ipc", "host"}, {"--privileged=true"}, {"--cap-add=SYS_ADMIN"}, {"--device", "/dev/sda"}} {
		if err := validateRunArguments(arguments); err == nil {
			t.Fatalf("accepted forbidden arguments: %v", arguments)
		}
	}
	if err := validateRunArguments([]string{"--cap-drop", "NET_RAW", "--cap-drop=SYS_PTRACE"}); err != nil {
		t.Fatal(err)
	}
}

func TestResolvedContainerBoundary(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	container := inspectedContainer{}
	container.HostConfig.CapDrop = []string{"NET_RAW", "SYS_PTRACE"}
	if err := validateContainerBoundary(container, assignment); err != nil {
		t.Fatal(err)
	}
	// Docker's native inspect normalizes explicitly dropped capabilities.
	container.HostConfig.CapDrop = []string{"CAP_NET_RAW", "CAP_SYS_PTRACE"}
	if err := validateContainerBoundary(container, assignment); err != nil {
		t.Fatal(err)
	}
	container.HostConfig.NetworkMode = "host"
	if err := validateContainerBoundary(container, assignment); err == nil {
		t.Fatal("accepted resolved host network")
	}
	container.HostConfig.NetworkMode = "default"
	container.HostConfig.CapDrop = nil
	if err := validateContainerBoundary(container, assignment); err == nil {
		t.Fatal("accepted missing capability boundary")
	}
}

func TestCleanupAttemptUsesAssignedComposeProjectWithoutContainers(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "docker.log")
	dockerPath := filepath.Join(directory, "docker")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
case "$1 $2" in
  "network ls") printf '%s\n' orphan-network ;;
  "volume ls") printf '%s\n' orphan-volume ;;
esac
`
	if err := os.WriteFile(dockerPath, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_DOCKER_LOG", logPath)

	err := cleanupAttempt(Assignment{
		RuntimeAttemptID:   "attempt-one",
		Generation:         1,
		ComposeProjectName: "attempt-one_devcontainer",
	})
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	commands := string(content)
	for _, expected := range []string{
		"network ls -q --filter label=com.docker.compose.project=attempt-one_devcontainer",
		"network rm orphan-network",
		"volume ls -q --filter label=com.docker.compose.project=attempt-one_devcontainer",
		"volume rm -f orphan-volume",
	} {
		if !strings.Contains(commands, expected) {
			t.Fatalf("cleanup did not inspect assigned Compose resources: %s", commands)
		}
	}
}

func TestDevelopmentTeardownRetainsNamedVolumes(t *testing.T) {
	for _, failedStart := range []bool{false, true} {
		t.Run(fmt.Sprintf("failed-start=%t", failedStart), func(t *testing.T) {
			directory := t.TempDir()
			logPath := filepath.Join(directory, "docker.log")
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
case "$1 $2" in
  "ps -aq") printf '%s\n' owned-primary ;;
  "inspect owned-primary") printf '[{"Id":"owned-primary","Config":{"Labels":{"com.docker.compose.project":"project_devcontainer"}}}]' ;;
  "network ls") printf '%s\n' owned-network ;;
  "volume ls") printf '%s\n' approved-data ;;
esac
`
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_DOCKER_LOG", logPath)
			assignment := Assignment{RuntimeAttemptID: "owned-attempt", Generation: 1, ComposeProjectName: "project_devcontainer", PreserveWorkspace: true}
			var err error
			if failedStart {
				err = cleanupAttempt(assignment)
			} else {
				err = cleanupProject(parentState{ComposeProjectName: assignment.ComposeProjectName, PreserveWorkspace: assignment.PreserveWorkspace})
			}
			if err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			commands := string(content)
			if !strings.Contains(commands, "rm -f owned-primary") || !strings.Contains(commands, "network rm owned-network") {
				t.Fatalf("development compute was not removed: %s", commands)
			}
			if strings.Contains(commands, "volume ") {
				t.Fatalf("development teardown touched durable named volumes: %s", commands)
			}
		})
	}
}

func TestDevcontainerStartReplacesOnlyAnOlderPrimary(t *testing.T) {
	for _, scenario := range []string{"older-running", "older-stopped", "current", "future", "same-generation-other-attempt", "invalid-generation", "wrong-project"} {
		t.Run(scenario, func(t *testing.T) {
			directory := t.TempDir()
			logPath := filepath.Join(directory, "commands")
			containerID := strings.Repeat("a", 64)
			docker := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_RESTART_LOG"
case "$1" in
  ps) printf '%s\n' "$FACTORY_RESTART_ID" ;;
  inspect)
    attempt=old-attempt; generation=1; project=project_devcontainer; running=true
    case "$FACTORY_RESTART_SCENARIO" in
      older-stopped) running=false ;;
      current) attempt=new-attempt; generation=2 ;;
      future) generation=3 ;;
      same-generation-other-attempt) generation=2 ;;
      invalid-generation) generation=invalid ;;
      wrong-project) project=unrelated_devcontainer ;;
    esac
    if [ -f "$FACTORY_RESTART_LOG.removed" ]; then attempt=new-attempt; generation=2; running=true; fi
    printf '[{"Id":"%s","State":{"Running":%s},"Config":{"Labels":{"factory.dev/runtime-attempt":"%s","factory.dev/runtime-generation":"%s","com.docker.compose.project":"%s"}},"HostConfig":{"CapDrop":["ALL"]}}]' "$FACTORY_RESTART_ID" "$running" "$attempt" "$generation" "$project" ;;
  rm) touch "$FACTORY_RESTART_LOG.removed" ;;
  *) exit 1 ;;
esac
`
			cli := `#!/bin/sh
printf 'devcontainer %s\n' "$*" >> "$FACTORY_RESTART_LOG"
printf '{"outcome":"success","containerId":"%s","composeProjectName":"project_devcontainer","remoteUser":"node","remoteWorkspaceFolder":"/workspace/project"}\n' "$FACTORY_RESTART_ID"
`
			for name, script := range map[string]string{"docker": docker, "devcontainer": cli} {
				if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_RESTART_LOG", logPath)
			t.Setenv("FACTORY_RESTART_ID", containerID)
			t.Setenv("FACTORY_RESTART_SCENARIO", scenario)
			_, err := startDevcontainer(context.Background(), Assignment{
				WorkspaceFolder:       directory,
				DevcontainerPath:      ".devcontainer/devcontainer.json",
				RemoteWorkspaceFolder: "/workspace/project",
				ComposeProjectName:    "project_devcontainer",
				RuntimeAttemptID:      "new-attempt",
				Generation:            2,
			})
			wantSuccess := strings.HasPrefix(scenario, "older-") || scenario == "current"
			if (err == nil) != wantSuccess {
				t.Fatalf("unexpected restart outcome: %v", err)
			}
			if !wantSuccess && !errors.Is(err, errDevcontainerNotStarted) {
				t.Fatalf("unadmitted start could trigger failed-create cleanup: %v", err)
			}
			content, _ := os.ReadFile(logPath)
			commands := string(content)
			removed := strings.Contains(commands, "rm -f "+containerID)
			if removed != strings.HasPrefix(scenario, "older-") {
				t.Fatalf("unexpected primary deletion: %s", commands)
			}
			if !wantSuccess && strings.Contains(commands, "devcontainer up") {
				t.Fatalf("started CLI across an unproven generation boundary: %s", commands)
			}
			for _, forbidden := range []string{"volume rm", "image rm", "network rm", "--remove-existing-container"} {
				if strings.Contains(commands, forbidden) {
					t.Fatalf("restart removed retained resources: %s", commands)
				}
			}
		})
	}
}

// Run this helper inside an owned private-Docker fixture using the exact shipped
// CLI. It exercises the same start call and boundary inspection as RunParent.
func TestDevcontainerRestartLive(t *testing.T) {
	if os.Getenv("FACTORY_DEVCONTAINER_RESTART_LIVE") != "1" {
		t.Skip("requires owned private-Docker fixture")
	}
	ctx := context.Background()
	var previous string
	var previousGeneration uint64
	for _, generation := range []uint64{1, 1, 2, 2} {
		assignment := Assignment{
			WorkspaceFolder: "/workspace/project", DevcontainerPath: ".devcontainer/devcontainer.json",
			RemoteWorkspaceFolder: "/workspace/project", ComposeProjectName: "project_devcontainer",
			RuntimeAttemptID: fmt.Sprintf("probe-%d", generation), Generation: generation,
		}
		result, err := startDevcontainer(ctx, assignment)
		if err != nil {
			t.Fatal(err)
		}
		if generation == previousGeneration && result.ContainerID != previous {
			t.Fatal("same attempt was recreated")
		}
		if previous != "" && generation != previousGeneration && result.ContainerID == previous {
			t.Fatal("old primary was rebound")
		}
		if previous == "" {
			file := filepath.Join(t.TempDir(), "retained.txt")
			if err := os.WriteFile(file, []byte("retained-approved-volume"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := exec.CommandContext(ctx, "docker", "cp", file, result.ContainerID+":/workspace/data/retained.txt").Run(); err != nil {
				t.Fatal(err)
			}
		} else {
			data, err := exec.CommandContext(ctx, "docker", "exec", result.ContainerID, "cat", "/workspace/data/retained.txt").Output()
			if err != nil || string(data) != "retained-approved-volume" {
				t.Fatalf("approved volume data did not survive primary replacement: %v", err)
			}
		}
		t.Logf("generation=%d container=%s", generation, result.ContainerID[:12])
		if generation == 1 && previous != "" {
			if err := exec.CommandContext(ctx, "docker", "stop", result.ContainerID).Run(); err != nil {
				t.Fatal(err)
			}
		}
		previous = result.ContainerID
		previousGeneration = generation
	}
}
