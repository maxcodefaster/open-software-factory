//go:build linux

package procutil

import (
	"os/exec"
	"syscall"
)

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
