package connector

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
	"golang.org/x/sys/unix"
)

// A private archive-only alias, never a remount of canonical Source. Root is
// RootlessKit's existing private root (mapped to Actor UID 1000), not node root.
// No new capabilities or runtime flags are needed. All extra mount flags tighten
// access; Project execution and normal Source writes use the unchanged checkout.
func nativeArchiveView(target string) (*os.File, func(), error) {
	const canonical = "/home/rootless/persist/project"
	denied := errors.New("private read-only/noatime Source archive view is unavailable")
	if workspacefiles.ValidateActorSourceIdentity("/home/rootless/persist") != nil || !filepath.IsAbs(target) || filepath.Clean(target) != target || filepath.Base(target) != "source-archive-view" {
		return nil, nil, denied
	}
	parent, err := os.Lstat(filepath.Dir(target))
	var stat unix.Stat_t
	if err != nil || !parent.IsDir() || parent.Mode().Perm() != 0700 || unix.Lstat(filepath.Dir(target), &stat) != nil || stat.Uid != 0 {
		return nil, nil, denied
	}
	if err := os.Mkdir(target, 0700); err != nil && !os.IsExist(err) {
		return nil, nil, denied
	}
	if unix.Lstat(target, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Uid != 0 || stat.Gid != 0 || stat.Mode&0777 != 0700 {
		return nil, nil, denied
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 0 {
		return nil, nil, denied
	}
	if err := unix.Mount(canonical, target, "", unix.MS_BIND, ""); err != nil {
		return nil, nil, denied
	}
	remove := func() { _ = unix.Unmount(target, 0) }
	flags := uintptr(unix.MS_BIND | unix.MS_REMOUNT | unix.MS_RDONLY | unix.MS_NOATIME | unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC)
	if err := unix.Mount("", target, "", flags, ""); err != nil {
		remove()
		return nil, nil, denied
	}
	fd, err := unix.Open(target, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		remove()
		return nil, nil, denied
	}
	file := os.NewFile(uintptr(fd), target)
	cleanup := func() { file.Close(); remove() }
	var fs unix.Statfs_t
	var source, view unix.Stat_t
	if unix.Stat(canonical, &source) != nil || unix.Fstat(fd, &view) != nil || source.Dev != view.Dev || source.Ino != view.Ino || view.Uid != 1000 || view.Gid != 1000 || unix.Fstatfs(fd, &fs) != nil || fs.Flags&unix.ST_RDONLY == 0 || fs.Flags&unix.ST_NOATIME == 0 {
		cleanup()
		return nil, nil, denied
	}
	return file, cleanup, nil
}
