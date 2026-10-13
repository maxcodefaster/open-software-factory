package workspacefiles

import (
	"syscall"

	"golang.org/x/sys/unix"
)

// Initialization may set checkout ownership. Serving must never regain that identity.
func DropSourcePrivileges() error {
	if _, _, err := syscall.AllThreadsSyscall6(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0); err != 0 {
		return err
	}
	if err := syscall.Setgroups(nil); err != nil {
		return err
	}
	if err := syscall.Setgid(101000); err != nil {
		return err
	}
	return syscall.Setuid(101000)
}
