package connector

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCLICancellationBoundsInheritedPipes(t *testing.T) {
	for _, owner := range []string{"runtime-docker", "browser-docker", "prebuild", "parent-git", "devcontainer-up"} {
		t.Run(owner, func(t *testing.T) {
			directory := t.TempDir()
			pidFile := filepath.Join(directory, "descendant")
			script := fmt.Sprintf("#!/bin/sh\n/bin/sleep 60 &\nprintf '%%s' \"$!\" > %q\nwait\n", pidFile)
			for _, binary := range []string{"docker", "git", "devcontainer"} {
				content := script
				if owner == "devcontainer-up" && binary == "docker" {
					content = "#!/bin/sh\nexit 0\n"
				}
				if err := os.WriteFile(filepath.Join(directory, binary), []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			joined := false
			go func() {
				var command *exec.Cmd
				switch owner {
				case "runtime-docker":
					command = runtimeDockerCommand(ctx, "info")
				case "browser-docker":
					_, err := browserDocker(ctx, "image", "inspect", "owned")
					done <- err
					return
				case "prebuild":
					command = prebuildCommand(ctx, directory, filepath.Join(directory, "devcontainer"), "build")
				case "parent-git":
					command = hardenedGitCommand(ctx, "", nil, "status")
				case "devcontainer-up":
					_, err := startDevcontainerWithConfiguration(ctx, Assignment{
						WorkspaceFolder: directory, RuntimeAttemptID: "owned-pipes", Generation: 1,
					}, func(context.Context, Assignment, bool) ([]string, error) { return nil, nil })
					done <- err
					return
				}
				var stdout, stderr bytes.Buffer
				command.Stdout, command.Stderr = &stdout, &stderr
				done <- command.Run()
			}()
			// Own the exact fixture descendant even on hosts whose assigned-process
			// implementation cannot kill a native Linux process group.
			var descendant *os.Process
			t.Cleanup(func() {
				cancel()
				if descendant != nil {
					_ = descendant.Kill()
				}
				if !joined {
					<-done
				}
			})
			until := time.Now().Add(2 * time.Second)
			for time.Now().Before(until) {
				raw, err := os.ReadFile(pidFile)
				pid, parseErr := strconv.Atoi(string(raw))
				if err == nil && parseErr == nil && pid > 0 {
					descendant, err = os.FindProcess(pid)
					if err != nil {
						t.Fatal(err)
					}
					break
				}
				time.Sleep(time.Millisecond)
			}
			if descendant == nil {
				t.Fatal("owned CLI did not start its pipe-holding descendant")
			}
			cancel()
			select {
			case err := <-done:
				joined = true
				if err == nil {
					t.Fatal("cancelled CLI reported success")
				}
				if runtime.GOOS == "linux" {
					// A zombie no longer owns pipes or executes work. Reaping
					// belongs to init after the fixture shell is killed.
					path := fmt.Sprintf("/proc/%d/stat", descendant.Pid)
					deadline := time.Now().Add(time.Second)
					for {
						raw, readErr := os.ReadFile(path)
						if os.IsNotExist(readErr) {
							break
						}
						fields := strings.Fields(string(raw)[strings.LastIndexByte(string(raw), ')')+1:])
						if readErr == nil && len(fields) > 0 && (fields[0] == "Z" || fields[0] == "X") {
							break
						}
						if time.Now().After(deadline) {
							t.Fatal("cancelled native CLI left its owned descendant running")
						}
						time.Sleep(time.Millisecond)
					}
				}
			case <-time.After(3 * time.Second):
				_ = descendant.Kill()
				<-done
				joined = true
				t.Fatal("cancelled CLI retained inherited stdout/stderr pipes")
			}
		})
	}
}

func TestCLIExitBoundsInheritedPipes(t *testing.T) {
	directory := t.TempDir()
	pidFile := filepath.Join(directory, "descendant")
	script := fmt.Sprintf("#!/bin/sh\n/bin/sleep 60 &\nprintf '%%s' \"$!\" > %q\nexit 0\n", pidFile)
	binary := filepath.Join(directory, "devcontainer")
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	command := prebuildCommand(ctx, directory, binary, "build")
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	done := make(chan error, 1)
	go func() { done <- command.Run() }()
	joined := false
	t.Cleanup(func() {
		cancel()
		raw, _ := os.ReadFile(pidFile)
		if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 {
			if process, err := os.FindProcess(pid); err == nil {
				_ = process.Kill()
			}
		}
		if !joined {
			<-done
		}
	})
	select {
	case err := <-done:
		joined = true
		if !errors.Is(err, exec.ErrWaitDelay) {
			t.Fatalf("CLI exit with inherited pipes was not reported as incomplete: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("exited CLI retained inherited stdout/stderr pipes")
	}
}
