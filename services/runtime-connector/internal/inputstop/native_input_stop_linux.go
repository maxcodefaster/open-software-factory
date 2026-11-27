package inputstop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"golang.org/x/sys/unix"
)

const (
	inputStopBun    = "/opt/factory/opencode/musl/bun"
	inputStopServer = "/opt/factory/opencode/server"
	inputStopGit    = "/home/rootless/persist/project/.git"
)

type inputStopOutput struct {
	buffer bytes.Buffer
	cancel context.CancelFunc
}

func (output *inputStopOutput) Write(data []byte) (int, error) {
	if output.buffer.Len()+len(data) > inputStopBytes {
		output.cancel()
		return 0, errors.New("native input Stop output exceeds its bound")
	}
	return output.buffer.Write(data)
}

// Its trusted native Parent caller must have Stop-only cold admission and a
// restored frozen Source. There is no lifecycle RPC, Docker call or retry here.
// The executable is the current Connector, never a Project-supplied program.
func Execute(ctx context.Context, input Assignment, binary string) (Result, error) {
	if input.Validate() != nil || os.Geteuid() != 0 || !filepath.IsAbs(binary) {
		return Result{}, errors.New("native input Stop requires its private root and exact assignment")
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return Result{}, err
	}
	childContext, cancel := context.WithCancel(ctx)
	defer cancel()
	parentReader, parentWriter, err := os.Pipe()
	if err != nil {
		return Result{}, err
	}
	defer parentReader.Close()
	defer parentWriter.Close()
	command := exec.CommandContext(childContext, binary, "native-input-stop-worker")
	command.Dir = "/"
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin"}
	command.Stdin = bytes.NewReader(encoded)
	command.ExtraFiles = []*os.File{parentReader}
	output := &inputStopOutput{cancel: cancel}
	command.Stdout = output
	command.Stderr = io.Discard
	command.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: unix.CLONE_NEWNS | unix.CLONE_NEWNET | unix.CLONE_NEWPID,
		Setpgid:    true,
	}
	command.Cancel = func() error {
		procutil.StopAssignedProcess(command)
		return nil
	}
	command.WaitDelay = 5 * time.Second
	// Go's pre-exec Pdeathsig check compares the Parent's outer PID with
	// getppid(), which is zero for this private namespace init. Arm that signal
	// in the trusted child instead, with its anonymous liveness pipe.
	// Retain the creating thread until joined because the signal is thread-bound.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := command.Run(); err != nil || ctx.Err() != nil {
		return Result{}, errors.New("native input Stop process exit is unconfirmed; original Source was retained")
	}
	// The child is PID 1 in its private PID namespace. Its exit tears down all
	// namespace descendants, including children that detached from its group.
	// Joining it precedes result publication and any subsequent Source export.
	return ConfirmWorkerResult(input, output.buffer.Bytes())
}

func mountInputStopPath(root, source, destination string, readOnly, device bool) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	var inherited unix.Statfs_t
	if err := unix.Statfs(source, &inherited); err != nil {
		return err
	}
	target := filepath.Join(root, destination)
	if !info.IsDir() {
		var file *os.File
		file, err = os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if file != nil {
			file.Close()
		}
	}
	if err != nil {
		return err
	}
	if err := unix.Mount(source, target, "", unix.MS_BIND, ""); err != nil {
		return err
	}
	flags := uintptr(unix.MS_BIND | unix.MS_REMOUNT | unix.MS_NOSUID)
	if !device || inherited.Flags&unix.ST_NODEV != 0 {
		flags |= unix.MS_NODEV
	}
	if readOnly || inherited.Flags&unix.ST_RDONLY != 0 {
		flags |= unix.MS_RDONLY
	}
	// RootlessKit inherits locked mount restrictions. Retain them rather than
	// trying to make non-executable metadata or fixed devices executable.
	if inherited.Flags&unix.ST_NOEXEC != 0 {
		flags |= unix.MS_NOEXEC
	}
	return unix.Mount("", target, "", flags, "")
}

func createInputStopDirectories(root string) error {
	// Construct the entire fixed skeleton before any bind mounts. Mkdir's mode
	// is filtered by bootstrap's private umask; explicitly permit traversal
	// after dropping to UID 1000 without changing that process-wide umask.
	// Never chmod a mounted tool or the original retained metadata.
	for _, directory := range []string{
		"/lib", "/usr", "/usr/lib", "/usr/bin", "/bin",
		"/opt", "/opt/factory", "/opt/factory/opencode",
		"/opt/factory/opencode/musl", inputStopServer,
		"/home", "/home/rootless", "/home/rootless/persist",
		"/home/rootless/persist/project", inputStopGit,
		"/dev", "/proc", "/tmp", "/workspace", "/workspace/project",
	} {
		path := filepath.Join(root, directory)
		if err := os.Mkdir(path, 0755); err != nil {
			return err
		}
		if err := os.Chmod(path, 0755); err != nil {
			return err
		}
	}
	return nil
}

// Do this only after constructing the skeleton and mounting fixed tools.
// Root without DAC_OVERRIDE cannot populate directories already owned by
// UID 1000. Change only new, unmounted ancestors, never tool or metadata binds.
func ownInputStopLocations(root string) error {
	for _, directory := range []string{"", "/home", "/home/rootless", "/usr", "/opt", "/workspace", "/workspace/project"} {
		if err := os.Chown(filepath.Join(root, directory), 1000, 1000); err != nil {
			return err
		}
	}
	return nil
}

func inputStopLoopback() error {
	socket, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(socket)
	request, err := unix.NewIfreq("lo")
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(socket, unix.SIOCGIFFLAGS, request); err != nil {
		return err
	}
	if request.Uint16()&unix.IFF_UP != 0 {
		// The pinned native stack already enables its private loopback and
		// rejects a redundant SIOCSIFFLAGS. Do not mutate an enabled interface.
		return nil
	}
	request.SetUint16(request.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(socket, unix.SIOCSIFFLAGS, request)
}

// This fixed child is launched only as private namespace PID 1. It exposes the
// original Git metadata but no checkout, Connector state, Docker files/socket,
// inherited Factory environment or network interface other than loopback.
func RunWorker() error {
	if os.Geteuid() != 0 || os.Getpid() != 1 {
		return errors.New("native input Stop worker requires its private namespace init")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	parent := os.NewFile(inputStopParentFD, "native input Stop Parent")
	if parent == nil {
		return errors.New("native input Stop Parent liveness is unavailable")
	}
	defer parent.Close()
	if err := ArmParent(parent); err != nil {
		return err
	}
	var input Assignment
	if ReadJSON(os.Stdin, &input) != nil || input.Validate() != nil {
		return errors.New("native input Stop assignment is invalid")
	}
	// Do not accept a symlink at any retained Source ancestor. The Parent has
	// already frozen the original writer, so no Project process can swap these
	// directories while this fixed namespace is constructed.
	for _, path := range []string{"/home/rootless", "/home/rootless/persist", "/home/rootless/persist/project", inputStopGit} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() {
			return errors.New("native input Stop metadata directory is invalid")
		}
	}
	metadata, err := unix.Open(inputStopGit, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("native input Stop metadata is unavailable")
	}
	defer unix.Close(metadata)
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return errors.New("native input Stop private mount isolation is unavailable")
	}
	if err := unix.Mount("tmpfs", "/tmp", "tmpfs", unix.MS_NODEV|unix.MS_NOSUID, "mode=1777"); err != nil {
		return errors.New("native input Stop private temporary storage is unavailable")
	}
	root, err := os.MkdirTemp("/tmp", "factory-input-stop-")
	if err != nil {
		return err
	}
	if err := os.Chmod(root, 0755); err != nil {
		return err
	}
	if err := createInputStopDirectories(root); err != nil {
		return err
	}
	// The unchanged packaged server identifies its native watcher with the
	// image's ldd --version. Preserve that exact Alpine ldd and its interpreter;
	// do not substitute a libc assertion or a different server build.
	for _, path := range []string{"/lib", "/usr/lib", "/bin/busybox", "/usr/bin/ldd", inputStopBun, inputStopServer} {
		if err := mountInputStopPath(root, path, path, true, false); err != nil {
			return errors.New("native input Stop fixed tools are unavailable")
		}
	}
	if err := os.Symlink("busybox", filepath.Join(root, "bin/sh")); err != nil {
		return err
	}
	if err := mountInputStopPath(root, fmt.Sprintf("/proc/self/fd/%d", metadata), inputStopGit, false, false); err != nil {
		return errors.New("native input Stop private metadata mount is unavailable")
	}
	for _, path := range []string{"/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"} {
		if err := mountInputStopPath(root, path, path, false, true); err != nil {
			return errors.New("native input Stop fixed devices are unavailable")
		}
	}
	if err := os.Chmod(filepath.Join(root, "tmp"), 0777|os.ModeSticky); err != nil {
		return err
	}
	if err := unix.Mount("proc", filepath.Join(root, "proc"), "proc", unix.MS_NODEV|unix.MS_NOSUID|unix.MS_NOEXEC, ""); err != nil {
		return errors.New("native input Stop private process observation is unavailable")
	}
	if err := inputStopLoopback(); err != nil {
		return errors.New("native input Stop private loopback is unavailable")
	}
	if err := ownInputStopLocations(root); err != nil {
		return errors.New("native input Stop empty location preparation is unavailable")
	}
	if err := unix.Chroot(root); err != nil {
		return err
	}
	if err := os.Chdir("/workspace/project"); err != nil {
		return err
	}
	if _, _, err := syscall.AllThreadsSyscall6(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0); err != 0 {
		return errors.New("native input Stop privilege fencing is unavailable")
	}
	if err := syscall.Setgroups(nil); err != nil {
		return err
	}
	if err := syscall.Setgid(1000); err != nil {
		return err
	}
	if err := syscall.Setuid(1000); err != nil {
		return err
	}
	if err := ArmParent(parent); err != nil {
		return err
	}
	// Read stdin once, before entering the restricted root. Bun receives only
	// that validated assignment through a new pipe, never the Parent's stdin.
	encoded, _ := json.Marshal(input)
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	if _, err := writer.Write(encoded); err != nil {
		reader.Close()
		writer.Close()
		return err
	}
	writer.Close()
	if err := unix.Dup2(int(reader.Fd()), 0); err != nil {
		reader.Close()
		return err
	}
	reader.Close()
	if err := parent.Close(); err != nil {
		return err
	}
	return syscall.Exec(inputStopBun, []string{inputStopBun, "--no-env-file", inputStopServer + "/input-stop.mjs"},
		[]string{"PATH=/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp"})
}
