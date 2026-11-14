package connector

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOwnedColdScriptsSelectStopBeforeDockerAndRejectPreviousModeMarker(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_INPUT_STOP_BOOTSTRAP_PROOF") != "1" {
		t.Skip("explicit owned cold-script proof only")
	}
	if _, err := os.Stat("/run/ate/identity/uid"); err == nil {
		t.Fatal("never run this fixture against a retained native Actor")
	}
	const binary = "/usr/local/bin/factory-runtime-connector"
	original, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(binary, original, 0555); err != nil {
			t.Error(err)
		}
	})
	directory := t.TempDir()
	trace := filepath.Join(directory, "calls")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(directory, name), []byte("#!/bin/sh\n"+body+"\n"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	write("id", "echo 1000")
	write("rootlesskit", fmt.Sprintf("test ! -e /home/rootless/persist/connector/source-restored.json || exit 91\nprintf 'rootless-start\\n' >> %q\nsleep 0.15", trace))
	write("python3", fmt.Sprintf(`printf 'python:%%s\n' "$*" >> %q
case "$*" in *wait.py\ bootstrap*) echo input-stop ;; *ready.py\ --input-stop*) exit 0 ;; *) exit 92 ;; esac`, trace))
	for _, name := range []string{"mount", "tinyproxy", "dockerd", "normal-launch"} {
		write(name, fmt.Sprintf("printf '%s\\n' >> %q\n%s", name, trace, map[bool]string{true: "exit 93", false: "exit 0"}[name == "dockerd" || name == "normal-launch"]))
	}
	trust := "/run/ate/egress-trust-bundle"
	state := "/home/rootless/persist/connector"
	if _, err := os.Stat(state); err == nil {
		t.Fatal("refusing existing Connector state")
	}
	for _, path := range []string{trust, state, "/run/user/1000"} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(trust, "trust-bundle.pem"), []byte("owned readable projection"), 0444); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "source-restored.json"), []byte(`{"old":"must-not-admit-this-cold-start"}`), 0600); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=" + directory + ":/usr/local/bin:/usr/bin:/bin", "XDG_RUNTIME_DIR=/run/user/1000",
		"DOCKER_HOST=unix:///run/user/1000/docker.sock", "FACTORY_SUBSTRATE_BOOTSTRAP=owned-fixture"}
	command := exec.CommandContext(t.Context(), "/bin/sh", "/opt/factory-rootless/start.sh", "normal-launch")
	command.Env = env
	if data, err := command.CombinedOutput(); err != nil {
		t.Fatalf("owned start branch: %v %s", err, data)
	}
	calls, err := os.ReadFile(trace)
	if err != nil || !strings.Contains(string(calls), "rootless-start") || !strings.Contains(string(calls), "--input-stop") ||
		strings.Contains(string(calls), "normal-launch") || strings.Contains(string(calls), "dockerd") {
		t.Fatalf("cold start crossed Stop boundary: %s %v", calls, err)
	}
	// Execute the actual inner script as well. Only its fixed infrastructure
	// commands are substituted; no Project/Dev Container initializer is present.
	helper := fmt.Sprintf(`#!/bin/sh
printf 'connector:%%s\n' "$*" >> %q
case "$1" in native-source-restore) exit 0 ;; native-bootstrap-mode) echo input-stop ;; native-parent) exit 0 ;; *) exit 94 ;; esac
`, trace)
	if err := os.WriteFile(binary, []byte(helper), 0555); err != nil {
		t.Fatal(err)
	}
	command = exec.CommandContext(t.Context(), "/bin/sh", "/opt/factory-rootless/runtime-child.sh")
	command.Env = env
	if data, err := command.CombinedOutput(); err != nil {
		t.Fatalf("owned runtime child: %v %s", err, data)
	}
	calls, err = os.ReadFile(trace)
	if err != nil || !strings.Contains(string(calls), "connector:native-parent") || strings.Contains(string(calls), "dockerd") {
		t.Fatalf("inner cold branch started Docker: %s %v", calls, err)
	}
	const storage = "/home/rootless/persist/docker"
	if _, err := os.Lstat(storage); !os.IsNotExist(err) {
		t.Fatal("Stop-only bootstrap created private Docker storage or found unrelated data")
	}
	if err := os.WriteFile(binary, []byte(strings.Replace(helper, "echo input-stop", "echo docker", 1)), 0555); err != nil {
		t.Fatal(err)
	}
	arguments := filepath.Join(directory, "docker-arguments")
	write("dockerd", fmt.Sprintf("printf '%%s\\n' \"$@\" > %q", arguments))
	run := func() ([]byte, error) {
		t.Helper()
		command := exec.CommandContext(t.Context(), "/bin/sh", "/opt/factory-rootless/runtime-child.sh")
		command.Env = env
		return command.CombinedOutput()
	}
	if data, err := run(); err != nil {
		t.Fatalf("owned Docker cold branch: %v %s", err, data)
	}
	args, err := os.ReadFile(arguments)
	if err != nil || !strings.Contains(string(args), "--data-root="+storage+"/graph\n") ||
		!strings.Contains(string(args), "--storage-driver=overlay2\n") || strings.Contains(string(args), "--storage-driver=vfs") {
		t.Fatalf("Docker did not select its native durable Overlay graph: %s %v", args, err)
	}
	private, err := os.Lstat(storage)
	if err != nil || !private.IsDir() || private.Mode().Perm() != 0700 {
		t.Fatalf("Docker graph has no separate private parent: %v %v", private, err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(storage) })
	marker := filepath.Join(storage, "retained-marker")
	if err := os.WriteFile(marker, []byte("retained Docker data"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(marker)
	if err != nil {
		t.Fatal(err)
	}
	if data, err := run(); err != nil {
		t.Fatalf("owned second Docker cold branch: %v %s", err, data)
	}
	after, err := os.Stat(marker)
	content, readErr := os.ReadFile(marker)
	if err != nil || readErr != nil || !os.SameFile(before, after) ||
		!before.ModTime().Equal(after.ModTime()) || string(content) != "retained Docker data" {
		t.Fatal("cold bootstrap replaced or modified retained private Docker data")
	}
	if err := os.RemoveAll(storage); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(directory, "unrelated")
	if err := os.Mkdir(target, 0755); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"symlink", "regular-file", "public-directory", "foreign-owner"} {
		t.Run(scenario, func(t *testing.T) {
			switch scenario {
			case "symlink":
				err = os.Symlink(target, storage)
			case "regular-file":
				err = os.WriteFile(storage, []byte("unrelated file"), 0600)
			case "public-directory":
				err = os.Mkdir(storage, 0755)
			case "foreign-owner":
				if err = os.Mkdir(storage, 0700); err == nil {
					err = os.Chown(storage, 1000, 1000)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			original, err := os.Lstat(storage)
			if err != nil {
				t.Fatal(err)
			}
			_ = os.Remove(arguments)
			if data, err := run(); err == nil {
				t.Fatalf("unsafe private Docker path started: %s", data)
			}
			if _, err := os.Stat(arguments); !os.IsNotExist(err) {
				t.Fatal("unsafe storage dispatched Docker")
			}
			retained, err := os.Lstat(storage)
			if err != nil || !os.SameFile(original, retained) || original.Mode() != retained.Mode() {
				t.Fatal("unsafe private path was changed instead of refused")
			}
			if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0755 {
				t.Fatal("unrelated symlink target was changed")
			}
			if err := os.Remove(storage); err != nil {
				t.Fatal(err)
			}
		})
	}
}
