//go:build linux

package connector

import (
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestContainerFilesRejectFIFOWithoutBlocking(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	if err := unix.Mkfifo(filepath.Join(root, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.read(ContainerFileRequest{Path: "/pipe"}); err == nil {
		t.Fatal("FIFO was accepted as an ordinary file")
	}
}

func TestContainerFilesRejectIndirectProcAccess(t *testing.T) {
	manager, err := newContainerFileManager("/")
	if err != nil {
		t.Fatal(err)
	}
	defer manager.close()
	root := t.TempDir()
	// An ordinary user can create a relative symlink to /proc without writing there.
	relative, err := filepath.Rel(root, "/proc/self/environ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(relative, filepath.Join(root, "indirect")); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.read(ContainerFileRequest{Path: filepath.Join(root, "indirect")}); err == nil {
		t.Fatal("proc filesystem was read through a symlink")
	}
}
