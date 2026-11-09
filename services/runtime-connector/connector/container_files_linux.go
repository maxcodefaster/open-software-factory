//go:build linux

package connector

import (
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

const containerNonblocking = unix.O_NONBLOCK

func (manager *containerFileManager) renameExclusive(source, destination string) error {
	from, err := manager.openDirectory(filepath.Dir(source))
	if err != nil {
		return err
	}
	defer from.Close()
	to, err := manager.openDirectory(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer to.Close()
	return unix.Renameat2(int(from.Fd()), filepath.Base(source), int(to.Fd()), filepath.Base(destination), unix.RENAME_NOREPLACE)
}

func allowedContainerFilesystem(file *os.File) bool {
	var info unix.Statfs_t
	if unix.Fstatfs(int(file.Fd()), &info) != nil {
		return false
	}
	return info.Type != unix.PROC_SUPER_MAGIC && info.Type != unix.SYSFS_MAGIC && info.Type != unix.DEVPTS_SUPER_MAGIC
}
