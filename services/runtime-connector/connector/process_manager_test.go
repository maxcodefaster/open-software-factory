package connector

import (
	"context"
	"io"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

type processTestWriter func([]byte) (int, error)

func (writer processTestWriter) Write(data []byte) (int, error) { return writer(data) }

func awaitProcessTestSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for process lifecycle transition")
	}
}

func TestProcessStopConcurrentFailedStarts(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "app", Command: []string{"factory-missing-process-race-command"}}}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for range 1000 {
			if err := manager.start("app"); err == nil {
				t.Error("missing command unexpectedly started")
			}
		}
	}()
	go func() {
		defer workers.Done()
		for range 10000 {
			// Stop may find an idle failed generation or a start in progress.
			_ = manager.stop("app")
		}
	}()
	workers.Wait()
}

func TestProcessStopIdleLifecycle(t *testing.T) {
	for _, test := range []struct {
		name        string
		state       string
		process     string
		supervising bool
	}{
		{name: "stopped", state: "stopped", process: "app", supervising: true},
		{name: "failed unsupervised App", state: "failed", process: "app"},
		{name: "failed supervised App", state: "failed", process: "app", supervising: true},
		{name: "failed non-App", state: "failed", process: "agent", supervising: true},
		{name: "starting", state: "starting", process: "app", supervising: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			assignment := validAssignment()
			assignment.Processes = []Process{{Name: test.process}}
			manager := newProcessManager(context.Background(), assignment, io.Discard)
			manager.supervising = test.supervising
			process := manager.processes[test.process]
			process.state = test.state
			process.generation = 7
			done := make(chan struct{})
			process.done = done
			if test.state != "starting" {
				close(done)
			}
			err := manager.stop(test.process)
			if test.state == "starting" {
				if err == nil || err.Error() != "process is not running" {
					t.Fatalf("Stop during start returned %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			wantGeneration := uint64(7)
			if test.state == "failed" && test.supervising && isAppProcess(test.process) {
				wantGeneration++
			}
			if process.state != test.state || process.generation != wantGeneration || process.done != done || process.intentionalStop {
				t.Fatalf("Stop changed ownership beyond the failed restart: %+v", process)
			}
			if err := manager.stop("unknown"); err == nil {
				t.Fatal("Stop accepted an undeclared process")
			}
		})
	}
}

func TestProcessStopDuringStartKeepsGeneration(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Processes = []Process{{Name: "app", Command: []string{"sh", "-c", "sleep 30"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	starting := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseStart := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseStart()
	writer := processTestWriter(func(data []byte) (int, error) {
		if string(data) == "FACTORY_PROCESS_STATE app starting\n" {
			close(starting)
			<-release
		}
		return len(data), nil
	})
	manager := newProcessManager(ctx, assignment, writer)
	defer manager.stopAll()
	started := make(chan error, 1)
	go func() { started <- manager.start("app") }()
	awaitProcessTestSignal(t, starting)
	manager.mutex.Lock()
	process := manager.processes["app"]
	generation, done := process.generation, process.done
	manager.mutex.Unlock()
	if err := manager.stop("app"); err == nil || err.Error() != "process is not running" {
		t.Fatalf("Stop during start returned %v", err)
	}
	manager.mutex.Lock()
	unchanged := process.generation == generation && process.done == done && !process.intentionalStop
	manager.mutex.Unlock()
	if !unchanged {
		t.Fatal("Stop invalidated the in-progress start")
	}
	releaseStart()
	select {
	case err := <-started:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("start did not complete")
	}
	if err := manager.stop("app"); err != nil {
		t.Fatal(err)
	}
	awaitProcessTestSignal(t, done)
}

func TestProcessStopWaitsForItsOriginalGeneration(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.Channels = []Channel{{Name: "app", Kind: "app"}}
	assignment.Processes = []Process{{Name: "app", Command: []string{"sh", "-c", "sleep 30"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopping := make(chan struct{})
	release := make(chan struct{})
	var stoppingOnce, releaseOnce sync.Once
	releaseStop := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseStop()
	writer := processTestWriter(func(data []byte) (int, error) {
		if string(data) == "FACTORY_PROCESS_STATE app stopping\n" {
			stoppingOnce.Do(func() {
				close(stopping)
				<-release
			})
		}
		return len(data), nil
	})
	manager := newProcessManager(ctx, assignment, writer)
	defer manager.stopAll()
	manager.supervise()
	if err := manager.start("app"); err != nil {
		t.Fatal(err)
	}
	manager.mutex.Lock()
	process := manager.processes["app"]
	command, done, generation := process.command, process.done, process.generation
	manager.mutex.Unlock()
	stopped := make(chan error, 1)
	go func() { stopped <- manager.stop("app") }()
	awaitProcessTestSignal(t, stopping)
	manager.mutex.Lock()
	unchanged := process.generation == generation && process.done == done && process.intentionalStop
	manager.mutex.Unlock()
	if !unchanged {
		t.Fatal("Stop invalidated the active waiter")
	}
	StopAssignedProcess(command)
	awaitProcessTestSignal(t, done)
	manager.mutex.Lock()
	state, restarts := process.state, process.restarts
	manager.mutex.Unlock()
	if state != "stopped" || restarts != 0 {
		t.Fatalf("intentional Stop became a crash: state=%s restarts=%d", state, restarts)
	}
	if err := manager.start("app"); err != nil {
		t.Fatal(err)
	}
	releaseStop()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop waited on the replacement generation")
	}
	manager.mutex.Lock()
	newCommand, newDone := process.command, process.done
	stillRunning := process.state == "running" && process.generation == generation+1
	manager.mutex.Unlock()
	if !stillRunning || newCommand == command || newDone == done {
		t.Fatal("Stop changed the replacement generation")
	}
	if err := manager.stop("app"); err != nil {
		t.Fatal(err)
	}
}

func TestProcessWaitKeepsFailurePolicy(t *testing.T) {
	for _, test := range []struct {
		name        string
		process     string
		development bool
		intentional bool
		shutdown    bool
		fatal       bool
	}{
		{name: "App crash", process: "app"},
		{name: "IDE crash", process: "ide", fatal: true},
		{name: "shared Agent crash", process: "agent", fatal: true},
		{name: "development Agent crash", process: "agent", development: true},
		{name: "intentional stop", process: "ide", intentional: true},
		{name: "shutdown", process: "ide", shutdown: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			assignment := validAssignment()
			assignment.Processes = []Process{{Name: test.process}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			manager := newProcessManager(ctx, assignment, io.Discard)
			manager.development = test.development
			command := exec.Command("sh", "-c", "exit 1")
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			process := manager.processes[test.process]
			process.command = command
			process.state = "running"
			process.generation = 1
			process.startedAt = time.Now()
			process.done = make(chan struct{})
			process.intentionalStop = test.intentional
			if test.shutdown {
				cancel()
			}
			manager.wait(test.process, 1, command)
			awaitProcessTestSignal(t, process.done)
			wantState := "failed"
			if test.intentional || test.shutdown {
				wantState = "stopped"
			}
			if process.state != wantState || process.command != nil || process.exitCode == nil || *process.exitCode != 1 {
				t.Fatalf("wait lost its exit outcome: %+v", process)
			}
			var fatal error
			select {
			case fatal = <-manager.fatal:
			default:
			}
			if (fatal != nil) != test.fatal || (fatal != nil && !strings.Contains(fatal.Error(), test.process)) {
				t.Fatalf("unexpected fatal failure: %v", fatal)
			}
		})
	}
}

func TestProcessWaitIgnoresStaleGeneration(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "ide"}}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	oldCommand := exec.Command("sh", "-c", "exit 1")
	if err := oldCommand.Start(); err != nil {
		t.Fatal(err)
	}
	process := manager.processes["ide"]
	command := exec.Command("sh", "-c", "exit 0")
	done := make(chan struct{})
	process.command, process.done = command, done
	process.state, process.generation = "running", 2
	manager.wait("ide", 1, oldCommand)
	if process.state != "running" || process.generation != 2 || process.command != command || process.done != done || process.exitCode != nil {
		t.Fatalf("old wait changed the replacement generation: %+v", process)
	}
	select {
	case <-done:
		t.Fatal("old wait closed the replacement generation's done channel")
	case err := <-manager.fatal:
		t.Fatalf("old wait reported a fatal failure: %v", err)
	default:
	}
}
