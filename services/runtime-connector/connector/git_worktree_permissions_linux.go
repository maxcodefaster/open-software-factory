package connector

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"golang.org/x/sys/unix"
)

// Parent Git can materialize files while the bootstrap umask is private.
// Canonical tracked source belongs to the checkout's admitted development UID.
// Restore ownership, not world-readable modes, and leave untracked data and
// private .git state alone. Every changed inode stays beneath the pinned root.
func ensureTrackedWorkspaceOwnership(ctx context.Context, workspace string) error {
	if os.Geteuid() != 0 {
		return nil
	}
	fd, err := unix.Open(workspace, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var root unix.Stat_t
	if err := unix.Fstat(fd, &root); err != nil {
		return err
	}
	if root.Uid == 0 {
		return nil
	}
	command := workspaceGitCommand(ctx, workspace, "ls-files", "--cached", "-z")
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		output.Close()
		return err
	}
	waited := false
	defer func() {
		output.Close()
		if !waited {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	reader := bufio.NewReaderSize(output, 4097)
	for {
		entry, err := reader.ReadSlice(0)
		if errors.Is(err, io.EOF) && len(entry) == 0 {
			break
		}
		if err != nil {
			return errors.New("canonical tracked Source paths could not be read")
		}
		name := string(entry[:len(entry)-1])
		if name == "" || path.IsAbs(name) || path.Clean(name) != name {
			return errors.New("canonical tracked Source path is invalid")
		}
		parts := strings.Split(name, "/")
		for index, part := range parts {
			if part == "." || part == ".." || part == ".git" {
				return errors.New("canonical tracked Source path is protected")
			}
			if err := shareTrackedSourceOwner(fd, strings.Join(parts[:index+1], "/"), root); err != nil {
				return fmt.Errorf("canonical tracked Source ownership could not be restored: %w", err)
			}
		}
	}
	err = command.Wait()
	waited = true
	if err != nil {
		return errors.New("canonical tracked Source inventory failed")
	}
	return nil
}

func shareTrackedSourceOwner(root int, name string, owner unix.Stat_t) error {
	fd, err := unix.Openat2(root, name, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_NOFOLLOW | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) ||
			errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EXDEV) {
			return nil // Missing source and protected link/mount targets are never modified.
		}
		return err
	}
	defer unix.Close(fd)
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil {
		return err
	}
	kind := info.Mode & unix.S_IFMT
	if info.Uid != 0 || (kind != unix.S_IFREG && kind != unix.S_IFDIR) {
		return nil
	}
	if kind == unix.S_IFREG && info.Nlink != 1 {
		return errors.New("tracked Source ownership refused a hard link")
	}
	return unix.Fchownat(fd, "", int(owner.Uid), int(owner.Gid), unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW)
}
