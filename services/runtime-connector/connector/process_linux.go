//go:build linux

package connector

import (
	"errors"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func requireMemoryFilesystem(path string) error {
	var info unix.Statfs_t
	if err := unix.Statfs(path, &info); err != nil || info.Type != unix.TMPFS_MAGIC {
		return errors.New("Runtime secrets require memory-backed storage")
	}
	return nil
}

func ProtectProcess() error {
	_, _, errno := syscall.Syscall(syscall.SYS_PRCTL, 4, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func PrepareAssignedProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func StopAssignedProcess(command *exec.Cmd) {
	if command.Process != nil {
		syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
}

func TerminateAssignedProcess(command *exec.Cmd) {
	if command.Process != nil {
		syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	}
}
