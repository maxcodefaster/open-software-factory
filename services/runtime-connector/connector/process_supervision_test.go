package connector

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func supervisedAssignment(t *testing.T, kinds ...string) (Assignment, string) {
	t.Helper()
	marker := filepath.Join(t.TempDir(), "starts")
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Channels = nil
	for _, kind := range kinds {
		assignment.Channels = append(assignment.Channels, Channel{Name: kind, Kind: kind})
	}
	assignment.Processes = []Process{{Name: "app", Command: []string{"sh", "-c", "echo start >> " + marker + "; exit 1"}}}
	return assignment, marker
}

func starts(marker string) int {
	data, _ := os.ReadFile(marker)
	return strings.Count(string(data), "start")
}

func TestStagingAppRestartsAfterItCrashesOnceReady(t *testing.T) {
	assignment, marker := supervisedAssignment(t, "app")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	manager.supervise()
	if err := manager.start("app"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for starts(marker) < 2 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if starts(marker) < 2 {
		t.Fatalf("a crashed Staging App was not restarted, starts=%d", starts(marker))
	}
}

func TestAppIsNotRestartedBeforeReadinessOrOutsideSharedRuntimes(t *testing.T) {
	for name, kinds := range map[string][]string{"before readiness": {"app"}, "development": {"app", "ide"}} {
		assignment, marker := supervisedAssignment(t, kinds...)
		ctx, cancel := context.WithCancel(context.Background())
		manager := newProcessManager(ctx, assignment, io.Discard)
		if name != "before readiness" {
			manager.supervise()
		}
		if err := manager.start("app"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(3 * time.Second)
		cancel()
		if starts(marker) != 1 {
			t.Fatalf("%s: the App was restarted, starts=%d", name, starts(marker))
		}
	}
}

func TestMissingCommandIsNamedInTheStartupFailure(t *testing.T) {
	assignment := validAssignment()
	assignment.Channels = []Channel{{Name: "app", Kind: "app"}}
	assignment.Processes = []Process{{Name: "app", Command: []string{"factory-missing-command", "run"}}}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	_ = manager.start("app")
	err := manager.startupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "could not start") ||
		!strings.Contains(err.Error(), "factory-missing-command") || strings.Contains(err.Error(), "code -1") {
		t.Fatalf("a missing command lost its cause: %v", err)
	}
}
