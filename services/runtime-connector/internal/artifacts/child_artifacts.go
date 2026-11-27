package artifacts

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
)

// Image-layer files can appear as overflow UID 65534 inside the native
// RootlessKit mapping. Docker copies that ownership into the primary, whose
// cap_drop: ALL root cannot chmod it. Stage only shipped executables in a new
// Parent-owned inode; never chown image layers, Source or Project metadata.
func StageChildExecutable(source string) (string, func(), error) {
	defer procutil.StartupPhase("child-executable-staging")()
	input, err := os.Open(source)
	if err != nil {
		return "", nil, err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, fmt.Errorf("Connector tool is not a readable regular file")
	}
	file, err := os.CreateTemp("", "factory-child-executable-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.Remove(file.Name()) }
	_, copyErr := io.Copy(file, input)
	modeErr := file.Chmod(0555)
	closeErr := file.Close()
	for _, err := range []error{copyErr, modeErr, closeErr} {
		if err != nil {
			cleanup()
			return "", nil, err
		}
	}
	return file.Name(), cleanup, nil
}

func CopyChildExecutable(ctx context.Context, containerID, source, destination string) error {
	path := source
	if os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID") != "" {
		staged, cleanup, err := StageChildExecutable(source)
		if err != nil {
			return err
		}
		defer cleanup()
		path = staged
	}
	defer procutil.StartupPhase("child-executable-copy")()
	if err := procutil.OwnedCommand(ctx, "docker", "cp", path, containerID+":"+destination).Run(); err != nil {
		return fmt.Errorf("copy Connector tool: %w", err)
	}
	return nil
}

func PrepareChildPermissions(ctx context.Context, containerID, connectorPath, assignmentPath string) error {
	defer procutil.StartupPhase("child-permissions")()
	// docker cp creates root-owned files even for an image with a non-root
	// USER. Only artifact setup uses root; the child keeps the CLI's user.
	command := procutil.OwnedCommand(ctx, "docker", "exec", "--user", "0:0", containerID,
		"sh", "-c", `chmod 0555 "$1" && chmod 0444 "$2"`,
		"factory-connector-setup", connectorPath, assignmentPath)
	if err := command.Run(); err != nil {
		return fmt.Errorf("prepare Connector child artifact permissions: %w", err)
	}
	return nil
}
