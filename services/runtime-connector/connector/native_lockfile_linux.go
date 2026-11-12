package connector

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// CLI 0.89.0 writes its Feature lockfile with fs.writeFile, preserving an
// existing inode's ownership. Reserve only a missing file before invoking it as
// the private Parent. Never repair, truncate or replace retained Project metadata,
// and never disable upstream lockfile generation or verification.
func reserveNativeDevcontainerLockfile(assignment Assignment) error {
	denied := errors.New("native Dev Container lockfile ownership is unavailable; existing metadata retained")
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		return denied
	}
	config := assignment.DevcontainerPath
	if config == "" || config == "." || strings.ContainsAny(config, "\x00\\") || filepath.IsAbs(config) || filepath.Clean(config) != config || config == ".." || strings.HasPrefix(config, "../") {
		return denied
	}
	root, err := unix.Open(assignment.WorkspaceFolder, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return denied
	}
	defer unix.Close(root)
	var stat unix.Stat_t
	if unix.Fstat(root, &stat) != nil || stat.Uid != 1000 || stat.Gid != 1000 {
		return denied
	}
	parent, err := unix.Openat2(root, filepath.Dir(config), &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NOATIME,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return denied
	}
	defer unix.Close(parent)
	if unix.Fstat(parent, &stat) != nil || stat.Uid != 1000 || stat.Gid != 1000 || stat.Mode&07000 != 0 {
		return denied
	}
	name := "devcontainer-lock.json"
	if strings.HasPrefix(filepath.Base(config), ".") {
		name = ".devcontainer-lock.json"
	}
	fd, err := unix.Openat(parent, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0644)
	if errors.Is(err, unix.EEXIST) {
		fd, err = unix.Openat(parent, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return denied
		}
		defer unix.Close(fd)
		if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&07000 != 0 || stat.Uid != 1000 || stat.Gid != 1000 || stat.Nlink != 1 {
			return denied
		}
		return nil
	}
	if err != nil {
		return denied
	}
	defer unix.Close(fd)
	// This descriptor was created exclusively by this invocation. This is not a
	// chown of an existing lockfile or an ownership projection during export.
	if unix.Fchown(fd, 1000, 1000) != nil || unix.Fsync(fd) != nil || unix.Fsync(parent) != nil {
		return denied
	}
	return nil
}
