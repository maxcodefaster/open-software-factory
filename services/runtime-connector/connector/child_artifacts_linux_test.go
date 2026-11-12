package connector

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestStageChildExecutableDoesNotCopyUnmappedImageOwnership(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	source := filepath.Join(t.TempDir(), "overflow-owned-tool")
	if err := os.WriteFile(source, []byte("shipped binary bytes"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(source, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	path, cleanup, err := stageChildExecutable(source)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	original, _ := os.Stat(source)
	staged, _ := os.Stat(path)
	old, next := original.Sys().(*syscall.Stat_t), staged.Sys().(*syscall.Stat_t)
	if old.Uid != 65534 || old.Gid != 65534 || next.Uid != uint32(os.Geteuid()) || next.Gid != uint32(os.Getegid()) || staged.Mode().Perm() != 0555 {
		t.Fatal("unmapped image ownership leaked into the copied child tool or the shipped image was repaired")
	}
}
