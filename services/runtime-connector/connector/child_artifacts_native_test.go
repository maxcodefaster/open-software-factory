package connector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Explicit native lane only. This exercises the real Actor-private daemon and
// retained cap_drop: ALL primary without starting a Child, hooks or Project work.
func TestChildArtifactsInNativeCapabilityDroppedPrimary(t *testing.T) {
	containerID := os.Getenv("FACTORY_CHILD_ARTIFACT_NATIVE_CONTAINER")
	if containerID == "" {
		t.Skip("requires an explicitly owned native primary")
	}
	attemptID := os.Getenv("FACTORY_CHILD_ARTIFACT_NATIVE_ATTEMPT")
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(containerID) || attemptID == "" || os.Geteuid() != 0 {
		t.Fatal("exact native primary identity and private namespace root are required")
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || len(strings.TrimSpace(string(uid))) != 36 {
		t.Fatal("native Actor identity projection is required")
	}
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", strings.TrimSpace(string(uid)))
	container, err := inspectContainer(containerID)
	if err != nil || container.ID != containerID || container.Config.Labels[attemptLabel] != attemptID || container.HostConfig.Privileged || len(container.HostConfig.CapAdd) != 0 || len(container.HostConfig.CapDrop) != 1 || container.HostConfig.CapDrop[0] != "ALL" {
		t.Fatal("native primary identity or capability isolation differs")
	}
	ctx := context.Background()
	command := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("owned artifact qualification failed: %v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	local := t.TempDir()
	source := filepath.Join(local, "tool")
	if err := os.WriteFile(source, []byte("#!/bin/sh\nprintf qualified-native-child-artifact"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(source, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	assignment := filepath.Join(local, "assignment.json")
	if err := os.WriteFile(assignment, []byte(`{"public":"owned artifact qualification"}`), 0600); err != nil {
		t.Fatal(err)
	}
	destination := "/tmp/" + filepath.Base(local)
	command("exec", "--user", "0:0", containerID, "mkdir", "-m", "0755", destination)
	defer command("exec", "--user", "0:0", containerID, "rmdir", destination)
	tool, recipe := destination+"/tool", destination+"/assignment.json"
	if err := copyChildExecutable(ctx, containerID, source, tool); err != nil {
		t.Fatal(err)
	}
	defer command("exec", "--user", "0:0", containerID, "rm", tool)
	command("cp", assignment, containerID+":"+recipe)
	defer command("exec", "--user", "0:0", containerID, "rm", recipe)
	if err := prepareChildPermissions(ctx, containerID, tool, recipe); err != nil {
		t.Fatal(err)
	}
	if got := command("exec", "--user", "1000:1000", containerID, tool); got != "qualified-native-child-artifact" {
		t.Fatal("development user could not execute the copied tool")
	}
	if got := command("exec", "--user", "0:0", containerID, "stat", "-c", "%u:%g:%a", tool, recipe); got != "0:0:555\n0:0:444" {
		t.Fatalf("tool and public assignment ownership/modes differ: %s", got)
	}
}
