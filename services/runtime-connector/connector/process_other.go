//go:build !linux

package connector

import (
	"errors"
	"os"
	"os/exec"
)

func requireMemoryFilesystem(_ string) error {
	return errors.New("Runtime secrets require the Linux execution boundary")
}

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
