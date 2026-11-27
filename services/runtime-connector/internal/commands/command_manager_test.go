package commands

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func ownedCommandManager(t *testing.T, send func(protocol.Message) error) *Manager {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")
	ctx, cancel := context.WithCancel(context.Background())
	manager := NewManager(ctx, protocol.Assignment{WorkspaceFolder: t.TempDir()}, send)
	t.Cleanup(func() { cancel(); manager.Close() })
	return manager
}

func waitCommand(t *testing.T, manager *Manager, id string) protocol.CommandView {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	manager.mutex.Lock()
	command := manager.commands[id]
	manager.mutex.Unlock()
	if command == nil {
		t.Fatal("command did not start")
	}
	select {
	case <-command.done:
	case <-timer.C:
		t.Fatal("owned command did not complete")
	}
	view, err := manager.Read(protocol.CommandRead{ID: id})
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func TestCommandRetainsSeparateOutputAndActualExitCode(t *testing.T) {
	manager := ownedCommandManager(t, nil)
	id := "10000000-0000-4000-8000-000000000001"
	_, err := manager.Start(protocol.CommandRequest{ID: id, Digest: strings.Repeat("a", 64), Command: "printf stdout; printf stderr >&2; exit 7"})
	if err != nil {
		t.Fatal(err)
	}
	view := waitCommand(t, manager, id)
	if view.State != "exited" || view.ExitCode == nil || *view.ExitCode != 7 || string(view.Stdout) != "stdout" || string(view.Stderr) != "stderr" {
		t.Fatalf("wrong command observation: %+v", view)
	}
	read, err := manager.Read(protocol.CommandRead{ID: id, Stdout: view.StdoutNext, Stderr: view.StderrNext})
	if err != nil || len(read.Stdout) != 0 || len(read.Stderr) != 0 {
		t.Fatal("output cursor replayed old bytes", err)
	}
}

func TestCommandIdentityNeverReexecutesAfterTransportLoss(t *testing.T) {
	manager := ownedCommandManager(t, func(protocol.Message) error { return fmt.Errorf("control detached") })
	id := "10000000-0000-4000-8000-000000000002"
	input := protocol.CommandRequest{ID: id, Digest: strings.Repeat("b", 64), Command: "printf once >> effect; sleep 0.05; printf done"}
	if _, err := manager.Start(input); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(input); err != nil {
		t.Fatal(err)
	}
	view := waitCommand(t, manager, id)
	if view.State != "exited" || string(view.Stdout) != "done" {
		t.Fatal("detachment changed the outcome")
	}
	if _, err := manager.Start(input); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(manager.assignment.WorkspaceFolder, "effect"))
	if err != nil || string(content) != "once" {
		t.Fatal("command ran more than once", err)
	}
	input.Command = "printf changed"
	if _, err := manager.Start(input); err == nil {
		t.Fatal("reused command identity accepted changed input")
	}
}

func TestCommandOutputIsBoundedAndReportsLostHistory(t *testing.T) {
	manager := ownedCommandManager(t, nil)
	id := "10000000-0000-4000-8000-000000000003"
	input := protocol.CommandRequest{ID: id, Digest: strings.Repeat("c", 64), Command: "head -c 100000 /dev/zero"}
	if _, err := manager.Start(input); err != nil {
		t.Fatal(err)
	}
	view := waitCommand(t, manager, id)
	if len(view.Stdout) != commandOutputBytes || view.StdoutNext != 100000 || !view.OutputLost || view.StdoutFrom != 100000-commandOutputBytes {
		t.Fatalf("unbounded or unmarked output: %+v", view)
	}
}

func TestCommandCancellationIsScopedAndUnknownCommandsNeverStart(t *testing.T) {
	manager := ownedCommandManager(t, nil)
	first := "10000000-0000-4000-8000-000000000004"
	second := "10000000-0000-4000-8000-000000000005"
	for _, id := range []string{first, second} {
		if _, err := manager.Start(protocol.CommandRequest{ID: id, Digest: strings.Repeat("d", 64), Command: "sleep 1; printf alive"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.Cancel(first); err != nil {
		t.Fatal(err)
	}
	if view := waitCommand(t, manager, first); view.State != "cancelled" {
		t.Fatal("owned command was not cancelled")
	}
	if view := waitCommand(t, manager, second); view.State != "exited" || string(view.Stdout) != "alive" {
		t.Fatal("cancel affected another command")
	}
	if _, err := manager.Read(protocol.CommandRead{ID: "missing"}); err == nil {
		t.Fatal("unknown status invented an outcome")
	}
	if _, err := manager.Cancel("missing"); err == nil {
		t.Fatal("unknown cancellation invented execution")
	}
}

func TestCompletedCommandOutputEvictionKeepsExecutionIdentity(t *testing.T) {
	manager := ownedCommandManager(t, nil)
	var first protocol.CommandRequest
	for index := 0; index < 130; index++ {
		input := protocol.CommandRequest{ID: fmt.Sprintf("10000000-0000-4000-8000-%012d", index), Digest: strings.Repeat("e", 64), Command: "printf x >> effect; printf output"}
		if index == 0 {
			first = input
		}
		if _, err := manager.Start(input); err != nil {
			t.Fatal(err)
		}
		waitCommand(t, manager, input.ID)
	}
	view, err := manager.Start(first)
	if err != nil || !view.OutputLost || len(view.Stdout) != 0 || view.State != "exited" {
		t.Fatal("retired output lost its execution record", err)
	}
	content, err := os.ReadFile(filepath.Join(manager.assignment.WorkspaceFolder, "effect"))
	if err != nil || len(content) != 130 {
		t.Fatal("retired command was replayed", err)
	}
}
