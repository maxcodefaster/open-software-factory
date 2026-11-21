package connector

import (
	"context"
	"os/exec"
	"time"
)

func ownedCommand(ctx context.Context, name string, arguments ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, name, arguments...)
	PrepareAssignedProcess(command)
	command.Cancel = func() error { StopAssignedProcess(command); return nil }
	command.WaitDelay = 2 * time.Second
	// This owns the local CLI and inherited pipes. Cancellation does not confirm
	// the outcome of work already dispatched to Docker or a remote service.
	return command
}
