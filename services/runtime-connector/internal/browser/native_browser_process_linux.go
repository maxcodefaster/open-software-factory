//go:build linux

package browser

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func prepareNativeBrowserProcess(command *exec.Cmd) error {
	if os.Geteuid() != 0 || os.Getegid() != 0 {
		return errors.New("native Browser control requires its private root process")
	}
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true, Pdeathsig: syscall.SIGKILL,
		Credential: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}},
	}
	return nil
}

func protectNativeBrowserDirectory(path string) error {
	var state unix.Stat_t
	if unix.Lstat(path, &state) != nil || state.Mode&unix.S_IFMT != unix.S_IFDIR ||
		state.Uid != 0 || state.Gid != 0 || state.Mode&0022 != 0 {
		return errors.New("native Browser control storage is not privately owned")
	}
	if os.Chmod(path, 0755) != nil {
		return errors.New("native Browser public configuration is unavailable")
	}
	return nil
}

func restrictNativeBrowserWorker() error {
	if os.Geteuid() != 1000 || os.Getegid() != 1000 {
		return errors.New("browser tools require the unprivileged Browser identity")
	}
	// Apply to every Go thread before exec can select another thread. This is
	// inherited by MCP, Chromium and its helpers, not a container-runtime flag.
	if _, _, errno := syscall.AllThreadsSyscall6(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0); errno != 0 {
		return errors.New("browser privilege escalation could not be disabled")
	}
	if unix.Setrlimit(unix.RLIMIT_NPROC, &unix.Rlimit{Cur: 256, Max: 256}) != nil {
		return errors.New("browser process count could not be bounded")
	}
	return nil
}
