package connector

import (
	"errors"
	"net"
	"os"
	"sync"
	"syscall"
	"time"
)

var socketUmask sync.Mutex

// listenPrivateUnix listens on a Unix socket that is never visible with
// permissions wider than 0600. The umask is tightened only around bind, so no
// other process can connect between creation and a later chmod. A leftover
// socket from a dead owner is removed first; a live owner, a symlink or any
// other file type at the path is an error.
func listenPrivateUnix(path string) (*net.UnixListener, error) {
	if err := removeStaleSocket(path); err != nil {
		return nil, err
	}
	socketUmask.Lock()
	previous := syscall.Umask(0o177)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	syscall.Umask(previous)
	socketUmask.Unlock()
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func removeStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	owner, known := info.Sys().(*syscall.Stat_t)
	if info.Mode()&os.ModeSocket == 0 || !known || int(owner.Uid) != os.Geteuid() {
		return errors.New("socket path is occupied by another file")
	}
	if connection, dialErr := net.DialTimeout("unix", path, 250*time.Millisecond); dialErr == nil {
		connection.Close()
		return errors.New("socket already has an owner")
	}
	return os.Remove(path)
}
