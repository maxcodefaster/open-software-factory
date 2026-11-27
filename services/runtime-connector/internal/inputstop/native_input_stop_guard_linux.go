package inputstop

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

const inputStopParentFD = 3

// The Parent alone retains the anonymous pipe's write end until its namespace
// init has joined. Check for an already-dead Parent after arming the kernel
// signal, closing the race before PR_SET_PDEATHSIG. The caller stays on its
// locked OS thread and re-arms after dropping credentials, which clears it.
func ArmParent(file *os.File) error {
	fail := errors.New("native input Stop Parent liveness could not be confirmed")
	if file == nil {
		return fail
	}
	fd := int(file.Fd())
	var info unix.Stat_t
	if unix.Fstat(fd, &info) != nil || info.Mode&unix.S_IFMT != unix.S_IFIFO {
		return fail
	}
	var filesystem unix.Statfs_t
	if unix.Fstatfs(fd, &filesystem) != nil || filesystem.Type != unix.PIPEFS_MAGIC {
		return fail
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil || flags&unix.O_ACCMODE != unix.O_RDONLY {
		return fail
	}
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, unix.FD_CLOEXEC); err != nil {
		return fail
	}
	if err := unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGKILL), 0, 0, 0); err != nil {
		return fail
	}
	poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	if count, err := unix.Poll(poll, 0); err != nil || count != 0 || poll[0].Revents != 0 {
		return fail
	}
	return nil
}
