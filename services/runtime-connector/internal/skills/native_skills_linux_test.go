package skills

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/trust"
)

func TestNativeSkillsCommandCancelsDescendants(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	pidFile := filepath.Join(t.TempDir(), "descendant")
	command := nativeSkillsCommand(ctx, "")
	command.Path = "/bin/sh"
	command.Args = []string{"sh", "-c", `sleep 60 & printf '%s' "$!" > "$1"; wait`, "sh", pidFile}
	var output nativeSkillsOutput
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	var descendant int
	t.Cleanup(func() {
		cancel()
		if descendant != 0 {
			_ = syscall.Kill(descendant, syscall.SIGKILL)
		}
		if command.ProcessState == nil {
			_ = command.Wait()
		}
	})
	until := time.Now().Add(2 * time.Second)
	for time.Now().Before(until) {
		data, _ := os.ReadFile(pidFile)
		descendant, _ = strconv.Atoi(string(data))
		if descendant > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	start := time.Now()
	err := command.Wait()
	if err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("installer group was not cancelled/reaped within its bound: %v", err)
	}
	if descendant == 0 {
		t.Fatal("installer did not start its owned descendant")
	}
	// A reparented zombie is dead and owns no pipes; PID1 owns its final reap.
	until = time.Now().Add(time.Second)
	for {
		data, err := os.ReadFile("/proc/" + strconv.Itoa(descendant) + "/stat")
		if os.IsNotExist(err) {
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		fields := strings.Fields(string(data)[strings.LastIndexByte(string(data), ')')+1:])
		if len(fields) > 0 && (fields[0] == "Z" || fields[0] == "X") {
			return
		}
		if time.Now().After(until) {
			t.Fatal("cancelled installer left its owned descendant running")
		}
		time.Sleep(time.Millisecond)
	}
}

// Explicit component proof only. Run as PID1 in an owned read-only-root Docker
// fixture with the same Skill volume mounted read-write at both fixed paths.
// This does not exercise Substrate Actor admission or snapshot restore.
func TestNativeSkillsOwnedControlFixture(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_SKILLS_PROOF") != "1" {
		t.Skip("requires the explicitly owned native skills component fixture")
	}
	if os.Getpid() != 1 || os.Geteuid() != 0 || os.Getegid() != 0 {
		t.Fatal("proof requires root control PID1")
	}
	assignment := nativeSkillsAssignment()
	for path, mode := range map[string]os.FileMode{
		"/run/ate/identity": 0755, trust.BootstrapStateDirectory: 0700,
		nativeSkillsControlDirectory: 0755,
	} {
		if err := os.MkdirAll(path, mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile("/run/ate/identity/uid", []byte(assignment.NativeActorUID()+"\n"), 0444); err != nil {
		t.Fatal(err)
	}
	content := []byte("#!/bin/sh\nprintf 'owned skill\\n'\n")
	digest := sha256.Sum256(content)
	path := "factory-6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1/scripts/check.sh"
	files := []struct {
		Path       string `json:"path"`
		Body       []byte `json:"body"`
		Digest     string `json:"digest"`
		Executable bool   `json:"executable"`
	}{{path, content, hex.EncodeToString(digest[:]), true}}
	encodedFiles, _ := json.Marshal(files)
	sum := sha256.Sum256(encodedFiles)
	manifest, _ := json.Marshal(struct {
		Digest string `json:"digest"`
		Files  any    `json:"files"`
	}{hex.EncodeToString(sum[:]), files})
	install := func() error { return InstallAdmittedSkills(t.Context(), assignment, string(manifest)) }
	if err := os.Chmod(nativeSkillsControlDirectory, 0777); err != nil {
		t.Fatal(err)
	}
	if err := install(); err == nil || !strings.Contains(err.Error(), "not protected") {
		t.Fatalf("uninitialized volume was not refused: %v", err)
	}
	if err := os.Chmod(nativeSkillsControlDirectory, 0755); err != nil {
		t.Fatal(err)
	}
	assignment.SetNativeActorUID("559d9659-2148-4df2-8263-0af82e2c979d")
	if err := install(); err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("wrong Actor was not refused: %v", err)
	}
	assignment = nativeSkillsAssignment()
	if err := install(); err != nil {
		t.Fatal(err)
	}
	if err := install(); err != nil {
		t.Fatalf("exact retry: %v", err)
	}
	work := "/run/factory-skills"
	target := filepath.Join(work, "admitted", path)
	asWork := func(script string) error {
		command := exec.Command("/bin/sh", "-ec", script)
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}}}
		output, err := command.CombinedOutput()
		if err != nil {
			return err
		}
		t.Logf("UID1000: %s", output)
		return nil
	}
	if err := asWork("test -r " + target + " && test -r " + work + "/admitted/.manifest.json && " + target); err != nil {
		t.Fatalf("Work could not read/execute admitted skill: %v", err)
	}
	for _, script := range []string{
		"printf changed >> " + target,
		"printf changed > " + work + "/admitted/.manifest.json",
		"rm " + work + "/admitted/.manifest.json",
		"mv " + work + "/admitted " + work + "/replaced",
		"mkdir " + work + "/unadmitted",
		"ln -s /tmp " + work + "/admitted-link",
		"ln -s /tmp " + work + "/admitted/injected",
		"chmod 0777 " + work,
		"chmod 0777 " + target,
		"chown 1000:1000 " + target,
	} {
		if err := asWork(script); err == nil {
			t.Fatalf("UID1000 modified sealed Skill storage: %s", script)
		}
	}
	if err := install(); err != nil {
		t.Fatalf("tampering changed admitted manifest: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(nativeSkillsControlDirectory, "admitted/.manifest.json")); err != nil || string(data) != string(manifest) {
		t.Fatalf("immutable manifest changed: %v", err)
	}
	// Privileged fixture corruption must be detected rather than silently sealed.
	controlTarget := filepath.Join(nativeSkillsControlDirectory, "admitted", path)
	if err := os.Chmod(controlTarget, 0777); err != nil {
		t.Fatal(err)
	}
	if err := install(); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("permission corruption was not refused: %v", err)
	}
	t.Log("component proof: protected volume, exact Actor, idempotent install, UID1000 read/execute and denied writes/symlinks, immutable manifest")
}
