//go:build !linux

package procutil

import (
	"os"
	"os/exec"
)

func ProtectProcess() error {
	return nil
}

func PrepareAssignedProcess(_ *exec.Cmd) {}

func TerminateAssignedProcess(command *exec.Cmd) {
	if command.Process != nil {
		command.Process.Signal(os.Interrupt)
	}
}

func StopAssignedProcess(command *exec.Cmd) {
	if command.Process != nil {
		command.Process.Kill()
	}
}
