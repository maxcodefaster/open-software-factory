package connector

import (
	"context"
	"fmt"
	"os/exec"
)

func prepareChildPermissions(ctx context.Context, containerID, connectorPath, assignmentPath string) error {
	// docker cp creates root-owned files even for an image with a non-root
	// USER. Only artifact setup uses root; the child keeps the CLI's user.
	command := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID,
		"sh", "-ec", `chmod 0555 "$1" && chmod 0444 "$2"`,
		"factory-connector-setup", connectorPath, assignmentPath)
	if err := command.Run(); err != nil {
		return fmt.Errorf("prepare Connector child artifact permissions: %w", err)
	}
	return nil
}
