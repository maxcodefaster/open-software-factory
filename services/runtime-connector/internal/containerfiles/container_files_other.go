//go:build !linux

package containerfiles

import (
	"os"
	"syscall"
)

const containerNonblocking = syscall.O_NONBLOCK

// Host tests publish regular files. Linux also supports atomic directory renames.
func (manager *Manager) renameExclusive(source, destination string) error {
	if err := manager.root.Link(source, destination); err != nil {
		return err
	}
	return manager.root.Remove(source)
}

// Portable tests use an owned Root. Deployed execution still requires Linux admission.
func allowedContainerFilesystem(file *os.File) bool { return file != nil }
