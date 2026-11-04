package connector

import (
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Unix socket paths are short on macOS, so avoid the long test temp root.
func socketDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "factory-sock-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return directory
}

func TestPrivateUnixSocketIsNeverWiderThanOwnerOnly(t *testing.T) {
	path := filepath.Join(socketDirectory(t), "a.sock")
	previous := syscall.Umask(0o022)
	defer syscall.Umask(previous)
	listener, err := listenPrivateUnix(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Lstat(path)
	if err != nil || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket mode is %v, %v", info.Mode(), err)
	}
	if restored := syscall.Umask(0o022); restored != 0o022 {
		t.Fatalf("umask was left at %o", restored)
	}
}

func TestPrivateUnixSocketRemovesStaleOwnerButNotLiveOrForeignPaths(t *testing.T) {
	directory := socketDirectory(t)
	stale := filepath.Join(directory, "stale.sock")
	dead, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	dead.SetUnlinkOnClose(false)
	dead.Close()
	if _, err := os.Lstat(stale); err != nil {
		t.Fatal("fixture did not leave a stale socket")
	}
	listener, err := listenPrivateUnix(stale)
	if err != nil {
		t.Fatalf("stale socket blocked the next owner: %v", err)
	}
	if again, err := listenPrivateUnix(stale); err == nil {
		again.Close()
		t.Fatal("a second process took over a live socket")
	}
	listener.Close()

	file := filepath.Join(directory, "file.sock")
	if err := os.WriteFile(file, []byte("not a socket"), 0600); err != nil {
		t.Fatal(err)
	}
	if again, err := listenPrivateUnix(file); err == nil {
		again.Close()
		t.Fatal("replaced a regular file")
	}
	link := filepath.Join(directory, "link.sock")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if again, err := listenPrivateUnix(link); err == nil {
		again.Close()
		t.Fatal("followed a symlink")
	}
	if content, err := os.ReadFile(file); err != nil || string(content) != "not a socket" {
		t.Fatal("a refused listen changed the file")
	}
}
