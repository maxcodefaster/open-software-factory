//go:build linux || darwin

package connector

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// Canonical Source survives its Parent. Earlier root Git writes may therefore
// already have private modes when a fresh Sandbox starts. Restore read access
// only for Git's public metadata, never credentials, OpenCode history or source.
// Directory-relative, no-follow descriptors keep untrusted Git entries from
// redirecting a permission change. Hard-linked private files are not admitted.
func ensureSharedGitReadable(workspace string) error {
	fd, err := unix.Open(workspace, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open canonical Source directory: %w", err)
	}
	root := os.NewFile(uintptr(fd), workspace)
	defer root.Close()
	metadata, err := openSharedGitEntry(root, ".git", true)
	if err != nil {
		return err
	}
	defer metadata.Close()
	if err := shareGitMetadataMode(metadata, true); err != nil {
		return err
	}
	for _, name := range []string{
		"HEAD", "config", "index", "packed-refs", "shallow", "FETCH_HEAD", "ORIG_HEAD",
		"MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "AUTO_MERGE",
	} {
		file, err := openSharedGitEntry(metadata, name, false)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		err = shareGitMetadataMode(file, false)
		file.Close()
		if err != nil {
			return err
		}
	}
	for _, name := range []string{"objects", "refs", "logs", "info"} {
		directory, err := openSharedGitEntry(metadata, name, true)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		err = shareGitMetadataTree(directory)
		directory.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func openSharedGitEntry(parent *os.File, name string, directory bool) (*os.File, error) {
	flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	if directory {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Openat(int(parent.Fd()), name, flags, 0)
	if err != nil {
		return nil, fmt.Errorf("open canonical Git metadata %s: %w", name, err)
	}
	return os.NewFile(uintptr(fd), name), nil
}

func shareGitMetadataMode(file *os.File, directory bool) error {
	var info unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &info); err != nil {
		return err
	}
	kind, read := uint32(unix.S_IFREG), uint32(0044)
	if directory {
		kind, read = unix.S_IFDIR, 0055
	}
	if uint32(info.Mode)&unix.S_IFMT != kind {
		return errors.New("canonical Git metadata has an unexpected file type")
	}
	mode := uint32(info.Mode) & 07777
	if mode&read == read {
		return nil
	}
	if !directory && info.Nlink != 1 {
		return errors.New("canonical Git metadata permission change refused a hard link")
	}
	return unix.Fchmod(int(file.Fd()), mode|read)
}

func shareGitMetadataTree(directory *os.File) error {
	if err := shareGitMetadataMode(directory, true); err != nil {
		return err
	}
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("canonical Git metadata permission change refused a symlink")
		}
		file, err := openSharedGitEntry(directory, entry.Name(), entry.IsDir())
		if err != nil {
			return err
		}
		if entry.IsDir() {
			err = shareGitMetadataTree(file)
		} else {
			err = shareGitMetadataMode(file, false)
		}
		file.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
