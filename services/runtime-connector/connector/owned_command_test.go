package connector

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParentGitCancellationBoundsInheritedPipes(t *testing.T) {
	directory := t.TempDir()
	pidFile := filepath.Join(directory, "descendant")
	script := fmt.Sprintf("#!/bin/sh\n/bin/sleep 60 &\nprintf '%%s' \"$!\" > %q\nwait\n", pidFile)
	if err := os.WriteFile(filepath.Join(directory, "git"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	joined := false
	go func() {
		command := hardenedGitCommand(ctx, "", nil, "status")
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
}
