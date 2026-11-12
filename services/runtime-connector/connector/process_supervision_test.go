package connector

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestProcessStopCancelsPendingAppRestart(t *testing.T) {
	assignment, marker := supervisedAssignment(t, "app")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scheduled := make(chan struct{})
	release := make(chan struct{})
	var scheduledOnce sync.Once
	var releaseOnce sync.Once
	releaseRestart := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseRestart()
	writer := processTestWriter(func(data []byte) (int, error) {
		if strings.HasPrefix(string(data), "FACTORY_PROCESS_OUTPUT app ") {
			scheduledOnce.Do(func() {
				close(scheduled)
				<-release
			})
		}
		return len(data), nil
	})
	manager := newProcessManager(ctx, assignment, writer)
	manager.supervise()
	process := manager.processes["app"]
	process.state = "failed"
	process.generation = 1
	process.done = make(chan struct{})
	close(process.done)
	code := 1
	process.exitCode = &code
	completed := make(chan struct{})
	go func() {
		manager.restartAfterFailure("app", 1, time.Second)
		close(completed)
	}()
	awaitProcessTestSignal(t, scheduled)
	if err := manager.stop("app"); err != nil {
		t.Fatal(err)
	}
	releaseRestart()
	awaitProcessTestSignal(t, completed)
	manager.mutex.Lock()
	state, exitCode := process.state, process.exitCode
	manager.mutex.Unlock()
	if starts(marker) != 0 || state != "failed" || exitCode != &code {
		t.Fatalf("Stop did not cancel the pending restart while retaining crash evidence: starts=%d state=%s", starts(marker), state)
	}
}

func TestProcessStopCancelsRestartBeforeItIsScheduled(t *testing.T) {
	assignment, marker := supervisedAssignment(t, "app")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	manager.supervise()
	process := manager.processes["app"]
	process.state, process.generation = "failed", 1
	if err := manager.stop("app"); err != nil {
		t.Fatal(err)
	}
	manager.restartAfterFailure("app", 1, time.Second)
	if process.restarts != 0 || starts(marker) != 0 {
		t.Fatalf("a retired crash still scheduled a restart: restarts=%d starts=%d", process.restarts, starts(marker))
	}
}

func TestProcessScheduledRestartRejectsRetiredGeneration(t *testing.T) {
	assignment, _ := supervisedAssignment(t, "app")
	assignment.Processes[0].Command = []string{"sh", "-c", "sleep 30"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.stopAll()
	manager.supervise()
	process := manager.processes["app"]
	process.state, process.generation = "failed", 1
	done := make(chan struct{})
	close(done)
	process.done = done
	if err := manager.stop("app"); err != nil {
		t.Fatal(err)
	}
	if err := manager.startProcess("app", scheduledProcessRestart, 1); err != nil {
		t.Fatal(err)
	}
	if process.state != "failed" || process.generation != 2 || process.command != nil || process.done != done {
		t.Fatalf("scheduled restart claimed a retired generation: %+v", process)
	}
	// Explicit Start remains allowed after cancelling an automatic restart.
	if err := manager.start("app"); err != nil {
		t.Fatal(err)
	}
	if err := manager.startProcess("app", scheduledProcessRestart, 2); err != nil {
		t.Fatal(err)
	}
	if err := manager.stop("app"); err != nil {
		t.Fatal(err)
	}
}

func TestProcessRestartBoundAndStableRunReset(t *testing.T) {
	for _, test := range []struct {
		name     string
		ranFor   time.Duration
		attempts int
		message  string
	}{
		{name: "exhausted", ranFor: time.Second, attempts: maximumAppRestarts + 1, message: "Factory stopped restarting this App after repeated failures."},
		{name: "stable run resets bound", ranFor: time.Minute, attempts: 1, message: "Factory restarts it in 2 seconds (attempt 1 of 5)."},
	} {
		t.Run(test.name, func(t *testing.T) {
			assignment, marker := supervisedAssignment(t, "app")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			writer := processTestWriter(func(data []byte) (int, error) {
				// Cancel at the announcement to exercise shutdown without waiting
				// through the production backoff or launching another process.
				cancel()
				return len(data), nil
			})
			manager := newProcessManager(ctx, assignment, writer)
			manager.supervise()
			process := manager.processes["app"]
			process.state, process.generation = "failed", 1
			process.restarts = maximumAppRestarts
			manager.restartAfterFailure("app", 1, test.ranFor)
			if process.restarts != test.attempts || !strings.Contains(string(manager.recent["app"]), test.message) || starts(marker) != 0 {
				t.Fatalf("restart bound or backoff changed: restarts=%d output=%q starts=%d", process.restarts, manager.recent["app"], starts(marker))
			}
			if err := manager.startProcess("app", scheduledProcessRestart, 1); err != nil {
				t.Fatal(err)
			}
			if process.generation != 1 || process.state != "failed" || process.command != nil {
				t.Fatal("scheduled restart claimed a generation during shutdown")
			}
		})
	}
}

func TestProcessShutdownStopsSupervisedApp(t *testing.T) {
	assignment, _ := supervisedAssignment(t, "app")
	assignment.Processes[0].Command = []string{"sh", "-c", "sleep 30"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newProcessManager(ctx, assignment, io.Discard)
	defer manager.stopAll()
	manager.supervise()
	if err := manager.start("app"); err != nil {
		t.Fatal(err)
	}
	manager.mutex.Lock()
	process := manager.processes["app"]
	done, generation := process.done, process.generation
	manager.mutex.Unlock()
	cancel()
	manager.stopAll()
	awaitProcessTestSignal(t, done)
	manager.mutex.Lock()
	stopped := process.state == "stopped" && process.command == nil && process.generation == generation && process.restarts == 0
	manager.mutex.Unlock()
	if !stopped {
		t.Fatal("shutdown lost the active waiter or scheduled an App restart")
	}
}
