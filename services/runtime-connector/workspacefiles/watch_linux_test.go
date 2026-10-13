package workspacefiles

import (
	"context"
	"os"
	"path/filepath"
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
