package workspacefiles

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestBundleDirectoryReadPreservesItsOwnAtimeAndRejectsForeignMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "saved"), []byte("retained bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	stamp := []unix.Timespec{{Sec: 1790000000, Nsec: 123456666}, {Sec: 1790000000, Nsec: 123456789}}
	if err := unix.UtimesNanoAt(unix.AT_FDCWD, root, stamp, 0); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	original := *info.Sys().(*syscall.Stat_t)
	reads := make(bundleDirectoryReads)
	for range 2 {
		// No O_NOATIME here: exercise the exact real getdents side effect the
		// pinned native kernel exhibits despite that flag.
		directory, err := os.Open(root)
		if err != nil {
			t.Fatal(err)
		}
		entries, err := reads.read(directory)
		directory.Close()
		if err != nil || len(entries) != 1 {
			t.Fatalf("bounded directory read failed: %v", err)
		}
		var current unix.Stat_t
		if unix.Stat(root, &current) != nil {
			t.Fatal("directory stat unavailable")
		}
		expected, err := reads.rebase(original)
		if err != nil || !sameBundleStat(expected, current) ||
			current.Atim != stamp[0] || current.Mtim != stamp[1] {
			t.Fatal("own directory read changed supported metadata or lost its exact ctime accounting")
		}
	}
	if err := os.Chmod(root, 0750); err != nil {
		t.Fatal(err)
	}
	directory, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if _, err := reads.read(directory); !errors.Is(err, ErrConflict) {
		t.Fatal("foreign directory metadata was rebased as an owned reader effect")
	}
	if info, err := os.Stat(root); err != nil || info.Mode().Perm() != 0750 {
		t.Fatal("rejected reader repaired foreign metadata")
	}
}

func TestBundleExportSerializesOtherSourceDirectoryReaders(t *testing.T) {
	root := t.TempDir()
	if os.Geteuid() == 0 {
		if err := os.Chown(root, 1000, 1000); err != nil {
			t.Fatal(err)
		}
	}
	source, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	output, err := os.CreateTemp(t.TempDir(), "bundle-")
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	source.writes.Lock()
	locked := true
	defer func() {
		if locked {
			source.writes.Unlock()
		}
	}()
	exportDone := make(chan error, 1)
	go func() { _, err := source.ExportBundle(output); exportDone <- err }()
	// Export is blocked at writes, so this observes its life-lock intent
	// without depending on archive size, arbitrary sleeps or a fake exporter.
	exclusive := false
	for deadline := time.Now().Add(250 * time.Millisecond); time.Now().Before(deadline); {
		if !source.life.TryRLock() {
			exclusive = true
			break
		}
		source.life.RUnlock()
		time.Sleep(time.Millisecond)
	}
	if !exclusive {
		source.writes.Unlock()
		locked = false
		<-exportDone
		t.Fatal("Source readers can change directory atime during a checkpoint export")
	}
	listed := make(chan error, 1)
	go func() { _, err := source.List(""); listed <- err }()
	select {
	case <-listed:
		source.writes.Unlock()
		locked = false
		<-exportDone
		t.Fatal("Source listing overtook export")
	case <-time.After(20 * time.Millisecond):
	}
	source.writes.Unlock()
	locked = false
	if err := <-exportDone; err != nil {
		t.Fatal(err)
	}
	if err := <-listed; err != nil {
		t.Fatal(err)
	}
}

func TestBundleDirectoryReadDoesNotAdoptChangesBeforeItsFirstRead(t *testing.T) {
	root := t.TempDir()
	info, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	original := *info.Sys().(*syscall.Stat_t)
	if err := os.WriteFile(filepath.Join(root, "unexpected"), []byte("retained late bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	directory, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	reads := make(bundleDirectoryReads)
	if _, err := reads.read(directory); err != nil {
		t.Fatal(err)
	}
	if _, err := reads.rebase(original); !errors.Is(err, ErrConflict) {
		t.Fatal("a pre-read foreign change was hidden by reader metadata accounting")
	}
}
