package workspacefiles

import (
	"io"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

type bundleDirectoryRead struct {
	original unix.Stat_t
	current  unix.Stat_t
}

// The pinned native gVisor updates directory atime on getdents even with
// O_NOATIME. Track only this export's own reads: retain the exact supported
// atime/mtime and account for our utimens-induced ctime, never an arbitrary
// directory ctime change before the next read. No mount or extra cap is needed.
type bundleDirectoryReads map[[2]uint64]bundleDirectoryRead

func sameDirectoryReadStat(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode &&
		a.Uid == b.Uid && a.Gid == b.Gid && a.Size == b.Size && a.Nlink == b.Nlink &&
		a.Atim == b.Atim && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func (reads bundleDirectoryReads) read(file *os.File) ([]os.DirEntry, error) {
	if reads == nil {
		return file.ReadDir(maxSourceEntries + 1)
	}
	fd := int(file.Fd())
	var before unix.Stat_t
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFDIR {
		return nil, ErrConflict
	}
	key := [2]uint64{uint64(before.Dev), before.Ino}
	prior, known := reads[key]
	if known && !sameDirectoryReadStat(prior.current, before) {
		return nil, ErrConflict
	}
	if !known {
		prior.original = before
	}
	entries, readErr := file.ReadDir(maxSourceEntries + 1)
	var after unix.Stat_t
	if unix.Fstat(fd, &after) != nil {
		return nil, ErrConflict
	}
	observedAtime := after.Atim
	after.Atim = before.Atim
	if !sameDirectoryReadStat(before, after) {
		return nil, ErrConflict // A reader may change atime, not names/mode/ctime.
	}
	if observedAtime != before.Atim {
		// "." is relative to the already pinned directory FD. Preserve current
		// mtime with UTIME_OMIT; never overwrite another writer's mtime.
		if err := unix.UtimesNanoAt(fd, ".", []unix.Timespec{
			before.Atim, {Nsec: unix.UTIME_OMIT},
		}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, err
		}
		var restored unix.Stat_t
		if unix.Fstat(fd, &restored) != nil {
			return nil, ErrConflict
		}
		expected := before
		expected.Ctim = restored.Ctim // Only our successful utimens operation.
		if !sameDirectoryReadStat(expected, restored) {
			return nil, ErrConflict
		}
		after = restored
	}
	prior.current = after
	reads[key] = prior
	if readErr != nil && readErr != io.EOF {
		return nil, readErr
	}
	return entries, readErr
}

func (reads bundleDirectoryReads) rebase(expected syscall.Stat_t) (syscall.Stat_t, error) {
	if expected.Mode&unix.S_IFMT != unix.S_IFDIR {
		return expected, nil
	}
	read, known := reads[[2]uint64{uint64(expected.Dev), expected.Ino}]
	if !known {
		return expected, nil
	}
	if !sameBundleStat(expected, read.original) {
		return expected, ErrConflict
	}
	expected.Ctim.Sec, expected.Ctim.Nsec = read.current.Ctim.Sec, read.current.Ctim.Nsec
	return expected, nil
}
