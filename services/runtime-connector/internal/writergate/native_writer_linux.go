package writergate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	nativeWriterTimeout    = 5 * time.Second
	nativeWriterPasses     = 128
	nativeWriterScanDelay  = 10 * time.Millisecond
	nativeWriterEntryLimit = 16384
	nativeWriterFileLimit  = 64 << 10
)

type Identity struct {
	uid, gid  uint32
	namespace string
}

type nativeWriterStatus struct {
	pid, tgid, threads int
	state              byte
	uids, gids         [4]uint32
	noNewPrivs, capEff uint64
}

type nativeWriterPeer struct {
	pid, tid int
	state    byte
}

// Only Work PID1 may call these, after Factory's Source admission/authority
// checks. Services must not mount canonical Source. The caller serializes
// Project spawning and barrier operations, and remains alive without writing
// Source itself until it refreshes permissions and explicitly resumes peers.
// Failure may leave some peers stopped: never silently resume on an error.
func FreezeNativeProjectWriters(ctx context.Context) error {
	return nativeProjectWriterBarrier(ctx, unix.SIGSTOP)
}

func ResumeNativeProjectWriters() error {
	return nativeProjectWriterBarrier(context.Background(), unix.SIGCONT)
}

func nativeProjectWriterBarrier(ctx context.Context, signal unix.Signal) error {
	// no_new_privs and capabilities are per-thread. Check and signal from the
	// same locked thread; this helper does not establish or change privileges.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	identity, err := CallerIdentity()
	if err != nil {
		return err
	}
	if signal != unix.SIGSTOP && signal != unix.SIGCONT {
		return errors.New("native writer barrier signal is invalid")
	}
	ctx, cancel := context.WithTimeout(ctx, nativeWriterTimeout)
	defer cancel()
	proc, err := nativeWriterOpenDirectory(nil, "/proc")
	if err != nil {
		return fmt.Errorf("native writer procfs unavailable: %w", err)
	}
	defer proc.Close()
	var filesystem unix.Statfs_t
	if err := unix.Fstatfs(int(proc.Fd()), &filesystem); err != nil || filesystem.Type != unix.PROC_SUPER_MAGIC {
		return errors.New("native writer observation requires real procfs")
	}
	self, err := nativeWriterReadlink(proc, "self")
	if err != nil || self != "1" {
		return errors.New("native writer procfs does not belong to PID1's namespace")
	}
	init, err := nativeWriterOpenDirectory(proc, "1")
	if err != nil {
		return fmt.Errorf("native writer PID1 unavailable: %w", err)
	}
	status, statusErr := nativeWriterReadStatus(init)
	identity.namespace, err = nativeWriterReadNamespace(init)
	init.Close()
	if statusErr != nil || err != nil {
		return errors.New("native writer PID1 identity is unreadable")
	}
	if err := nativeWriterValidateStatus(status, identity, 1, 1); err != nil {
		return err
	}
	if status.noNewPrivs != 1 || status.capEff != 0 {
		return errors.New("native writer PID1 privileges are not bounded")
	}

	var previous []nativeWriterPeer
	confirmed := false
	for pass := 0; pass < nativeWriterPasses; pass++ {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("native writer barrier unconfirmed: %w", err)
		}
		ids, err := nativeWriterIDs(proc)
		if err != nil {
			return err
		}
		for _, pid := range ids {
			// This excludes the entire caller thread group, not just its
			// leader. Never use kill(-1), process groups, or caller TIDs.
			if pid == 1 {
				continue
			}
			if err := ctx.Err(); err != nil {
				return fmt.Errorf("native writer barrier unconfirmed: %w", err)
			}
			peer, err := nativeWriterOpenDirectory(proc, strconv.Itoa(pid))
			if nativeWriterVanished(err) {
				continue
			}
			if err != nil {
				return fmt.Errorf("native writer peer %d unavailable: %w", pid, err)
			}
			peers, complete, inspectErr := nativeWriterInspect(ctx, peer, identity, pid)
			if inspectErr == nil && len(peers) != 0 && (complete || signal == unix.SIGSTOP) {
				// A proc directory FD pins the observed process, avoiding
				// numeric-PID reuse between inspection and signalling.
				// Unsupported pidfd signalling fails closed; no kill fallback.
				inspectErr = unix.PidfdSendSignal(int(peer.Fd()), signal, nil, 0)
				if nativeWriterVanished(inspectErr) {
					inspectErr = nil // Freeze still requires a fresh full scan.
				}
			}
			peer.Close()
			if inspectErr != nil {
				return fmt.Errorf("native writer peer %d barrier failed: %w", pid, inspectErr)
			}
			if !complete && signal == unix.SIGCONT {
				return errors.New("native writer resume peer identity is unconfirmed")
			}
		}
		if signal == unix.SIGCONT {
			return nil
		}
		peers, complete, err := nativeWriterScan(ctx, proc, identity)
		if err != nil {
			return err
		}
		stopped := nativeWriterQuiescent(peers, complete)
		// Re-STOP and re-enumerate even an already-stopped set. Two equal
		// complete stopped scans close enumeration/fork/exit races. Zombies
		// require all remaining threads inspected or kernel-confirmed exit.
		if stopped && confirmed && slices.Equal(previous, peers) {
			if err := ctx.Err(); err != nil {
				return fmt.Errorf("native writer freeze unconfirmed: %w", err)
			}
			return nil
		}
		previous, confirmed = peers, stopped
		select {
		case <-ctx.Done():
			return fmt.Errorf("native writer freeze unconfirmed: %w", ctx.Err())
		case <-time.After(nativeWriterScanDelay):
		}
	}
	return errors.New("native writer freeze did not reach stable confirmed quiescence")
}

func nativeWriterQuiescent(peers []nativeWriterPeer, complete bool) bool {
	if !complete {
		return false
	}
	for _, peer := range peers {
		// A ptrace stop ('t') is not a confirmed group SIGSTOP.
		if peer.state != 'T' {
			return false
		}
	}
	return true
}

func CallerIdentity() (Identity, error) {
	// Reject ordinary host/test processes before opening procfs or signalling.
	pid, uid, gid := os.Getpid(), os.Geteuid(), os.Getegid()
	if pid != 1 || uid <= 0 || gid <= 0 {
		return Identity{}, errors.New("native writer barrier requires actual PID 1 and non-root effective UID/GID")
	}
	noNewPrivs, err := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)
	if err != nil {
		return Identity{}, errors.New("native writer no_new_privs is unreadable")
	}
	header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var caps [2]unix.CapUserData
	if unix.Capget(&header, &caps[0]) != nil {
		return Identity{}, errors.New("native writer effective capabilities are unreadable")
	}
	if err := nativeWriterValidateCaller(pid, uid, gid, noNewPrivs, uint64(caps[0].Effective)|uint64(caps[1].Effective)<<32); err != nil {
		return Identity{}, err
	}
	return Identity{uid: uint32(uid), gid: uint32(gid)}, nil
}

// Pure validation is separately testable; passing fixture values never opens a
// signalling path. Only nativeProjectWriterBarrier obtains the real identity.
func nativeWriterValidateCaller(pid, uid, gid, noNewPrivs int, caps uint64) error {
	if pid != 1 || uid <= 0 || gid <= 0 || uint64(uid) > 1<<32-1 || uint64(gid) > 1<<32-1 ||
		noNewPrivs != 1 || caps != 0 {
		return errors.New("native writer barrier requires PID1, non-root UID/GID, existing no_new_privs and zero effective capabilities")
	}
	return nil
}

func nativeWriterValidateStatus(status nativeWriterStatus, identity Identity, pid, tgid int) error {
	if identity.uid == 0 || identity.gid == 0 || status.pid != pid || status.tgid != tgid {
		return errors.New("native writer process identity changed")
	}
	for i := range status.uids {
		// Saved/fs identities must not retain an unexpected writer identity.
		if status.uids[i] != identity.uid || status.gids[i] != identity.gid {
			return errors.New("native writer encountered an unexpected UID/GID")
		}
	}
	return nil
}

// These inspection helpers never signal and can use bounded procfs fixtures.
// Such fixtures are component evidence, not native writer-isolation proof.
func nativeWriterScan(ctx context.Context, proc *os.File, identity Identity) ([]nativeWriterPeer, bool, error) {
	ids, err := nativeWriterIDs(proc)
	if err != nil {
		return nil, false, err
	}
	if !slices.Contains(ids, 1) {
		return nil, false, errors.New("native writer scan lost PID1")
	}
	var peers []nativeWriterPeer
	complete := true
	for _, pid := range ids {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		if pid == 1 {
			continue
		}
		process, err := nativeWriterOpenDirectory(proc, strconv.Itoa(pid))
		if nativeWriterVanished(err) {
			complete = false
			continue
		}
		if err != nil {
			return nil, false, err
		}
		tasks, observed, err := nativeWriterInspect(ctx, process, identity, pid)
		process.Close()
		if err != nil {
			return nil, false, fmt.Errorf("native writer peer %d observation failed: %w", pid, err)
		}
		complete = complete && observed
		peers = append(peers, tasks...)
		if len(peers) > nativeWriterEntryLimit {
			return nil, false, errors.New("native writer task scan limit exceeded")
		}
	}
	return peers, complete, nil
}

func nativeWriterInspect(ctx context.Context, process *os.File, identity Identity, pid int) ([]nativeWriterPeer, bool, error) {
	return nativeWriterInspectTasks(ctx, process, identity, pid, nativeWriterIDs, nativeWriterProcessExited)
}

// A real pidfd becomes readable only after the entire thread group exits, not
// merely when its leader becomes a zombie. This observes without reaping a
// managed child or adding an orphan/lifecycle manager. It is used only after
// validating a zombie leader whose task directory disappeared. That leader's
// PID cannot be reused while any of its sibling threads remain alive.
func nativeWriterProcessExited(pid int) (bool, error) {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return false, err
	}
	defer unix.Close(fd)
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	if _, err := unix.Poll(fds, 0); err != nil {
		return false, err
	}
	if fds[0].Revents & ^int16(unix.POLLIN|unix.POLLHUP) != 0 {
		return false, errors.New("native writer process exit observation is invalid")
	}
	return fds[0].Revents&unix.POLLIN != 0, nil
}

func nativeWriterInspectTasks(ctx context.Context, process *os.File, identity Identity, pid int,
	taskIDs func(*os.File) ([]int, error), exited func(int) (bool, error)) ([]nativeWriterPeer, bool, error) {
	status, err := nativeWriterReadStatus(process)
	if nativeWriterVanished(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := nativeWriterValidateStatus(status, identity, pid, pid); err != nil {
		return nil, false, err
	}
	vanishedTasks := func() ([]nativeWriterPeer, bool, error) {
		if status.state != 'Z' || exited == nil {
			return nil, false, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		confirmed, err := exited(pid)
		if nativeWriterVanished(err) {
			return nil, false, nil // Still require a subsequent complete scan.
		}
		return nil, confirmed && err == nil, err
	}
	task, err := nativeWriterOpenDirectory(process, "task")
	if nativeWriterVanished(err) {
		return vanishedTasks()
	}
	if err != nil {
		return nil, false, err
	}
	defer task.Close()
	ids, err := taskIDs(task)
	if nativeWriterVanished(err) {
		// Native gVisor can retain a zombie's status while task getdents
		// permanently returns ENOENT. Require kernel-confirmed whole-group
		// exit, not the leader state alone. All other races remain incomplete.
		return vanishedTasks()
	}
	if err != nil {
		return nil, false, err
	}
	complete := len(ids) == status.threads && slices.Contains(ids, pid)
	var peers []nativeWriterPeer
	for _, tid := range ids {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		thread, err := nativeWriterOpenDirectory(task, strconv.Itoa(tid))
		if nativeWriterVanished(err) {
			complete = false
			continue
		}
		if err != nil {
			return nil, false, err
		}
		observed, readErr := nativeWriterReadStatus(thread)
		if readErr == nil {
			readErr = nativeWriterValidateStatus(observed, identity, tid, pid)
		}
		// A zombie group leader can still have live sibling threads.
		// Inspect every task and its namespace; never skip the group just
		// because the leader is a zombie.
		if readErr == nil && observed.state != 'Z' {
			var namespace string
			namespace, readErr = nativeWriterReadNamespace(thread)
			if readErr == nil && namespace != identity.namespace {
				readErr = errors.New("native writer peer belongs to another PID namespace")
			}
		}
		thread.Close()
		if nativeWriterVanished(readErr) {
			complete = false
			continue
		}
		if readErr != nil {
			return nil, false, readErr
		}
		if observed.state != 'Z' {
			peers = append(peers, nativeWriterPeer{pid: pid, tid: tid, state: observed.state})
		}
	}
	return peers, complete, nil
}

func nativeWriterOpenDirectory(parent *os.File, path string) (*os.File, error) {
	dir := unix.AT_FDCWD
	if parent != nil {
		dir = int(parent.Fd())
	}
	fd, err := unix.Openat(dir, path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func nativeWriterReadStatus(directory *os.File) (nativeWriterStatus, error) {
	fd, err := unix.Openat(int(directory.Fd()), "status", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nativeWriterStatus{}, err
	}
	file := os.NewFile(uintptr(fd), "status")
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, nativeWriterFileLimit+1))
	if err != nil {
		return nativeWriterStatus{}, err
	}
	return parseNativeWriterStatus(string(data))
}

func nativeWriterReadlink(directory *os.File, path string) (string, error) {
	var target [128]byte
	size, err := unix.Readlinkat(int(directory.Fd()), path, target[:])
	if err != nil {
		return "", err
	}
	if size == 0 || size == len(target) {
		return "", errors.New("native writer procfs link is invalid")
	}
	return string(target[:size]), nil
}

func nativeWriterReadNamespace(directory *os.File) (string, error) {
	namespace, err := nativeWriterReadlink(directory, "ns/pid")
	if err != nil {
		return "", err
	}
	inode, enclosed := strings.CutPrefix(namespace, "pid:[")
	inode, closed := strings.CutSuffix(inode, "]")
	number, parseErr := strconv.ParseUint(inode, 10, 64)
	if !enclosed || !closed || parseErr != nil || number == 0 || strconv.FormatUint(number, 10) != inode {
		return "", errors.New("native writer PID namespace identity is invalid")
	}
	return namespace, nil
}

func nativeWriterIDs(directory *os.File) ([]int, error) {
	// Open a fresh directory description so repeated scans start at offset 0.
	scan, err := nativeWriterOpenDirectory(directory, ".")
	if err != nil {
		return nil, err
	}
	defer scan.Close()
	names, err := scan.Readdirnames(nativeWriterEntryLimit + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(names) > nativeWriterEntryLimit {
		return nil, errors.New("native writer process scan limit exceeded")
	}
	var ids []int
	for _, name := range names {
		if name == "" || name[0] < '0' || name[0] > '9' {
			continue
		}
		pid, err := strconv.ParseUint(name, 10, 31)
		if err != nil || pid == 0 || strconv.FormatUint(pid, 10) != name {
			return nil, errors.New("native writer procfs PID is invalid")
		}
		ids = append(ids, int(pid))
	}
	slices.Sort(ids)
	return ids, nil
}

func nativeWriterVanished(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, unix.ESRCH)
}

func parseNativeWriterStatus(data string) (nativeWriterStatus, error) {
	var status nativeWriterStatus
	fail := errors.New("native writer process status is invalid or incomplete")
	if len(data) == 0 || len(data) > nativeWriterFileLimit || !strings.HasSuffix(data, "\n") {
		return status, fail
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(data, "\n") {
		key, value, found := strings.Cut(line, ":")
		switch key {
		case "Pid", "Tgid", "Threads", "State", "Uid", "Gid", "NoNewPrivs", "CapEff":
		default:
			continue
		}
		if !found || seen[key] {
			return nativeWriterStatus{}, fail
		}
		seen[key] = true
		value = strings.TrimSpace(value)
		fields := strings.Fields(value)
		switch key {
		case "State":
			states := map[string]byte{
				"R (running)": 'R', "S (sleeping)": 'S', "D (disk sleep)": 'D',
				"T (stopped)": 'T', "t (tracing stop)": 't', "Z (zombie)": 'Z',
				"X (dead)": 'X', "I (idle)": 'I',
			}
			var known bool
			status.state, known = states[value]
			if !known {
				return nativeWriterStatus{}, fail
			}
		case "Uid", "Gid":
			if len(fields) != 4 {
				return nativeWriterStatus{}, fail
			}
			var ids [4]uint32
			for i, field := range fields {
				number, err := strconv.ParseUint(field, 10, 32)
				if err != nil || strconv.FormatUint(number, 10) != field {
					return nativeWriterStatus{}, fail
				}
				ids[i] = uint32(number)
			}
			if key == "Uid" {
				status.uids = ids
			} else {
				status.gids = ids
			}
		case "CapEff":
			number, err := strconv.ParseUint(value, 16, 64)
			if err != nil || len(value) != 16 || strings.ContainsAny(value, "+-") {
				return nativeWriterStatus{}, fail
			}
			status.capEff = number
		default:
			number, err := strconv.ParseUint(value, 10, 31)
			if err != nil || strconv.FormatUint(number, 10) != value {
				return nativeWriterStatus{}, fail
			}
			switch key {
			case "Pid":
				status.pid = int(number)
			case "Tgid":
				status.tgid = int(number)
			case "Threads":
				status.threads = int(number)
			case "NoNewPrivs":
				if number > 1 {
					return nativeWriterStatus{}, fail
				}
				status.noNewPrivs = number
			}
		}
	}
	if len(seen) != 8 || status.pid == 0 || status.tgid == 0 || status.threads == 0 {
		return nativeWriterStatus{}, fail
	}
	return status, nil
}
