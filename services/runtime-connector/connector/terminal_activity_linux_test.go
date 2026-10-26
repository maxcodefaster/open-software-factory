package connector

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestTerminalActivityDistinguishesAnIdlePromptFromItsForegroundJob(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager := newTerminalManager(ctx, Assignment{WorkspaceFolder: t.TempDir()}, func(Message) error { return nil })
	session, err := manager.start("activity")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = session.file.Write([]byte("\x03exit\n"))
		_ = session.file.Close()
		_ = session.command.Process.Kill()
		_ = session.command.Wait()
	}()
	wait := func(expected bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if terminalBusy(session) == expected {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("terminal did not reach busy=%v", expected)
	}
	wait(false)
	if _, err := session.file.Write([]byte("sleep 2\n")); err != nil {
		t.Fatal(err)
	}
	wait(true)
	wait(false)
	session.executable = nil
	if !terminalBusy(session) {
		t.Fatal("missing executable identity was treated as an idle prompt")
	}
	if _, err := os.Stat("/proc/self/stat"); err != nil {
		t.Fatal("native terminal proof lost proc")
	}
}
