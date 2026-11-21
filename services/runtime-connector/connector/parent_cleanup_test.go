package connector

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func cleanupDockerFixture(t *testing.T, script string) string {
	t.Helper()
	directory := t.TempDir()
	log := filepath.Join(directory, "commands")
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FACTORY_CLEANUP_LOG\"\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_CLEANUP_LOG", log)
	return log
}

func TestCleanupProjectUnavailableInspectionFailsClosed(t *testing.T) {
	for _, project := range []string{"", "owned-compose"} {
		t.Run(project, func(t *testing.T) {
			log := cleanupDockerFixture(t, "case \"$1\" in inspect) exit 1 ;; *) exit 0 ;; esac\n")
			err := cleanupProject(t.Context(), parentState{ContainerID: "owned-primary", ComposeProjectName: project})
			if err == nil {
				t.Error("unavailable primary inspection was reported as successful cleanup")
			}
			commands, _ := os.ReadFile(log)
			if string(commands) != "inspect owned-primary\n" {
				t.Errorf("unavailable primary inspection permitted further cleanup: %s", commands)
			}
		})
	}
}

func TestParentCleanupDoesNotOverwriteFailureWithStopped(t *testing.T) {
	for _, scenario := range []string{"cleanup", "earlier-and-cleanup", "earlier", "success"} {
		t.Run(scenario, func(t *testing.T) {
			script := "exit 0\n"
			if strings.Contains(scenario, "cleanup") {
				script = "case \"$1\" in ps) exit 1 ;; *) exit 0 ;; esac\n"
			}
			cleanupDockerFixture(t, script)
			var original error
			if strings.Contains(scenario, "earlier") {
				original = errors.New("earlier owned cleanup failed")
			}
			var messages []Message
			err := finishParentCleanup(context.Background(), parentState{ComposeProjectName: "owned"}, func(message Message) error {
				messages = append(messages, message)
				return nil
			}, original)
			if original != nil && !errors.Is(err, original) {
				t.Errorf("earlier failure was discarded: %v", err)
			}
			if strings.Contains(scenario, "cleanup") && (err == nil || !strings.Contains(err.Error(), "list inner runtime resources")) {
				t.Errorf("cleanup failure was discarded: %v", err)
			}
			if strings.Contains(scenario, "cleanup") {
				var exited interface{ ExitCode() int }
				if !errors.As(err, &exited) || exited.ExitCode() != 1 {
					t.Errorf("joined cleanup lost the original command error: %v", err)
				}
			}
			phase := "cleanup-failed"
			if scenario == "success" {
				phase = "stopped"
				if err != nil {
					t.Error(err)
				}
			}
			if len(messages) != 1 || messages[0].Phase != phase {
				t.Fatalf("final status overwrote failure: %#v", messages)
			}
		})
	}
}

func TestParentCleanupAfterCancellationKeepsReportingErrors(t *testing.T) {
	log := cleanupDockerFixture(t, "exit 0\n")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	reportError := errors.New("final status outcome is unconfirmed")
	err := finishParentCleanup(ctx, parentState{ComposeProjectName: "owned"}, func(message Message) error {
		if message.Phase != "stopped" {
			t.Errorf("cancelled Parent did not complete its independent cleanup: %#v", message)
		}
		return reportError
	}, nil)
	if !errors.Is(err, reportError) {
		t.Fatalf("lost final status was reported as success: %v", err)
	}
	commands, _ := os.ReadFile(log)
	if !strings.Contains(string(commands), "volume ls") {
		t.Fatalf("Parent cancellation skipped owned cleanup: %s", commands)
	}
}
