package workspacefiles

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func awaitChange(t *testing.T, stream <-chan Change, name string) {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case change, open := <-stream:
			if !open {
				t.Fatal("watch ended before observing source change")
			}
			if change.Path == name || change.Kind == "resync" {
				return
			}
		case <-timer.C:
			t.Fatalf("source watch did not observe %q", name)
		}
	}
}

func TestSourceWatchesHumanAndRuntimeWritesWithoutCompute(t *testing.T) {
	source, checkout := testSource(t)
	if err := os.Mkdir(filepath.Join(checkout, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := source.Watch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Write("src/human.ts", []byte("human"), ""); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, stream, "src/human.ts")
	if err := os.WriteFile(filepath.Join(checkout, "src", "human.ts"), []byte("runtime edit"), 0644); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, stream, "src/human.ts")
	if err := os.Mkdir(filepath.Join(checkout, "new"), 0755); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, stream, "new")
	if err := os.WriteFile(filepath.Join(checkout, "new", "nested.ts"), []byte("runtime"), 0644); err != nil {
		t.Fatal(err)
	}
	awaitChange(t, stream, "new/nested.ts")
	cancel()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case _, open := <-stream:
			if !open {
				return
			}
		case <-deadline.C:
			t.Fatal("cancellation retained the source watch")
		}
	}
}

func TestSourceWatchCloseAndBoundedOverflow(t *testing.T) {
	source, checkout := testSource(t)
	stream, err := source.Watch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 256; index++ {
		if err := os.WriteFile(filepath.Join(checkout, "burst"), []byte{byte(index)}, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case _, open := <-stream:
			if !open {
				return
			}
		case <-timer.C:
			t.Fatal("Close blocked on a slow watch reader")
		}
	}
}

func TestSourceWatchSlowReaderGetsResync(t *testing.T) {
	watch := &sourceWatch{changes: make(chan Change, watchQueue)}
	for index := 0; index <= watchQueue; index++ {
		watch.emit(Change{Path: "app.ts", Kind: "updated"})
	}
	if len(watch.changes) != 1 {
		t.Fatalf("slow reader retained an event backlog: %d", len(watch.changes))
	}
	if change := <-watch.changes; change.Kind != "resync" {
		t.Fatalf("overflow silently lost changes: %#v", change)
	}
}

func TestSourceWatchUnreadableSubtreeKeepsAccessibleFilesLive(t *testing.T) {
	// Linux test containers normally start as root. Exercise ordinary DAC as
	// the shipped Source service, not CAP_DAC_OVERRIDE's permission bypass.
	if os.Geteuid() == 0 {
		directory, err := os.MkdirTemp("", "factory-source-watch-unprivileged-")
		if err != nil {
			t.Fatal(err)
		}
		defer os.RemoveAll(directory)
		if err := os.Chmod(directory, 0755); err != nil {
			t.Fatal(err)
		}
		// go test's own build directory may be root-private. Do not change
		// its permissions; copy only this owned executable into our fixture.
		binary, err := os.ReadFile(os.Args[0])
		if err != nil {
			t.Fatal(err)
		}
		executable := filepath.Join(directory, "workspacefiles.test")
		if err := os.WriteFile(executable, binary, 0555); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(executable, 0555); err != nil {
			t.Fatal(err)
		}
		child := exec.Command(executable, "-test.run=^"+t.Name()+"$", "-test.v")
		child.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: 101000, Gid: 101000},
		}
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("unprivileged Source watch failed: %v\n%s", err, output)
		}
		return
	}
	source, checkout := testSource(t)
	if err := os.Mkdir(filepath.Join(checkout, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(checkout, "private")
	if err := os.Mkdir(private, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(private, 0700) })
	if _, err := source.List("private"); !errors.Is(err, syscall.EACCES) {
		t.Fatalf("fixture did not enforce unreadable source: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := source.Watch(ctx)
	if err != nil {
		t.Fatalf("an unreadable child disabled the entire source watch: %v", err)
	}
	another := filepath.Join(checkout, "another-private")
	if err := os.Mkdir(another, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(another, 0700) })
	// Creating another unreadable directory forces the same recursive rebuild.
	// A resync followed by a closed stream is not proof of a functioning watch.
	awaitChange(t, stream, "another-private")
	if _, err := source.Write("src/after.ts", []byte("readable source"), ""); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case change, open := <-stream:
			if !open {
				t.Fatal("source watch ended after encountering an unreadable child")
			}
			if change.Path != "src/after.ts" {
				continue
			}
			if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0 {
				t.Fatalf("watching changed private directory permissions: %v, %v", info, err)
			}
			if _, err := source.List("private"); !errors.Is(err, syscall.EACCES) {
				t.Fatalf("private source access was widened: %v", err)
			}
			if err := os.Chmod(checkout, 0000); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(checkout, 0700) })
			if _, err := source.Watch(ctx); !errors.Is(err, syscall.EACCES) {
				t.Fatalf("an unreadable checkout root was reported as watchable: %v", err)
			}
			return
		case <-timer.C:
			t.Fatal("readable source changes were lost after an unreadable subtree")
		}
	}
}
