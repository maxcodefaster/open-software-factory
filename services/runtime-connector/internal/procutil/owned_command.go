package procutil

import (
	"context"
	"os/exec"
	"regexp"
	"time"
)

// CommandIDPattern matches lowercase hyphenated UUIDs used for command, terminal
// and container file transfer identities.
var CommandIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func OwnedCommand(ctx context.Context, name string, arguments ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, name, arguments...)
	PrepareAssignedProcess(command)
	command.Cancel = func() error { StopAssignedProcess(command); return nil }
	command.WaitDelay = 2 * time.Second
	// This owns the local CLI and inherited pipes. Cancellation does not confirm
	// the outcome of work already dispatched to Docker or a remote service.
	return command
}
