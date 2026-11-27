//go:build linux

package connector

import (
	"syscall"
	"testing"
)

func TestNativeParentControlReconnectRetainsOriginalTransportAndCheckpoint(t *testing.T) {
	git := newNativeParentControlGit(t)
	fixture := newNativeParentControlFixture(t)
	first := fixture.peer()
	fixture.started(first, true)
	fixture.write(first, nativeParentControlGitRequest())
	git.wait(fixture)
	// Both requests stay behind the blocked Git operation and retain their
	// original response transport, even when that socket is subsequently lost.
	drain := nativeParentControlDrain(nativeParentControlCheckpoint, nativeParentControlCheckpoint)
	fixture.write(first, drain)
	fixture.write(first, Message{Type: "operation-request", Action: "git-push", OperationID: "late-original-writer"})
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := fixture.peer()
	if first == second {
		t.Fatal("reconnect reused the closed peer socket")
	}
	fixture.started(second, true)
	if err := git.process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("losing the transport cancelled admitted Git work:", err)
	}
	probes := []Message{
		{Type: "operation-request", Action: "workspace-git", OperationID: "late-reconnected-git"},
		nativeParentControlDrain(nativeParentControlOtherCheckpoint, nativeParentControlOtherCheckpoint),
		{Type: "operation-request", Action: "browser-inspection", OperationID: "late-reconnected-browser"},
		{Type: "operation-request", Action: "source-resume", OperationID: "cannot-unfence", Data: nativeParentControlOtherCheckpoint},
		drain,
	}
	for _, probe := range probes {
		fixture.write(second, probe)
	}
	if err := git.process.Kill(); err != nil {
		t.Fatal("release owned Git subprocess:", err)
	}
	for index, probe := range probes {
		wantError := nativeParentControlFenced
		if index == len(probes)-1 {
			wantError = ""
		}
		// No response for the old Git, drain or queued writer may appear
		// here. Each operation retains the transport on which it arrived.
		fixture.reply(second, probe, wantError)
	}
	fixture.stop(second)
	if git.calls(t) != 1 || fixture.requests.Load() != 2 {
		t.Fatalf("reconnect replayed Git or replaced its admitted transport: connections=%d", fixture.requests.Load())
	}
}
