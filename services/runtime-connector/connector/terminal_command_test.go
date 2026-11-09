package connector

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestTerminalCommandUsesExistingPTYWithoutStealingBrowserAttachment(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	ctx, cancel := context.WithCancel(context.Background())
	manager := newTerminalManager(ctx, Assignment{WorkspaceFolder: t.TempDir()}, func(Message) error { return nil })
	t.Cleanup(func() { cancel(); manager.closeAll() })
	id := "20000000-0000-4000-8000-000000000001"
	input := CommandRequest{ID: id, Digest: strings.Repeat("a", 64)}
	opened, err := manager.openCommand(input)
	if err != nil || opened.State != "running" || opened.PID <= 0 {
		t.Fatal("PTY did not open", err)
	}
	manager.attach(Message{StreamID: "owned-browser", Path: "/" + id})
	if _, err := manager.inputCommand(terminalCommandInput{ID: id, Input: []byte("V=retained; printf '__begin__%s__end__\\n' \"$V\"\n")}, false); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var observed CommandView
	for time.Now().Before(deadline) {
		observed, err = manager.readCommand(CommandRead{ID: id})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(observed.Stdout), "__begin__retained__end__") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(string(observed.Stdout), "__begin__retained__end__") {
		t.Fatal("same PTY shell state was not observed")
	}
	manager.mutex.Lock()
	attachment := manager.sessions[id].attachment
	manager.mutex.Unlock()
	if attachment != "owned-browser" {
		t.Fatal("MCP reading stole the browser attachment")
	}
	if _, err := manager.inputCommand(terminalCommandInput{ID: id, Columns: 90, Rows: 25}, true); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.inputCommand(terminalCommandInput{ID: id, Columns: 1, Rows: 25}, true); err == nil {
		t.Fatal("invalid PTY size was accepted")
	}
	closed, err := manager.closeCommand(CommandRead{ID: id})
	if err != nil || closed.State != "cancelled" || closed.PID != opened.PID {
		t.Fatal("wrong PTY close", err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		observed, err = manager.readCommand(CommandRead{ID: id})
		if err == nil && observed.State == "cancelled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil || observed.State != "cancelled" {
		t.Fatal("closed PTY outcome was not retained", err)
	}
	repeated, err := manager.openCommand(input)
	if err != nil || repeated.State != "cancelled" || repeated.PID != opened.PID {
		t.Fatal("repeated open replaced an exited PTY", err)
	}
}

func TestTerminalCommandScrollbackPagesReportMissingHistory(t *testing.T) {
	manager := newTerminalManager(context.Background(), Assignment{}, func(Message) error { return nil })
	id := "20000000-0000-4000-8000-000000000002"
	manager.completed[id] = CommandView{ID: id, Digest: strings.Repeat("b", 64), State: "exited",
		Stdout: []byte(strings.Repeat("x", maxTerminalScrollback)), StdoutFrom: 100, StdoutNext: 100 + maxTerminalScrollback}
	first, err := manager.readCommand(CommandRead{ID: id})
	if err != nil || !first.OutputLost || first.StdoutFrom != 100 || len(first.Stdout) != 16384 {
		t.Fatal("terminal page lost its bounds", err)
	}
	next, err := manager.readCommand(CommandRead{ID: id, Stdout: first.StdoutNext})
	if err != nil || next.OutputLost || next.StdoutFrom != first.StdoutNext || len(next.Stdout) != 16384 {
		t.Fatal("terminal cursor replayed output", err)
	}
}
