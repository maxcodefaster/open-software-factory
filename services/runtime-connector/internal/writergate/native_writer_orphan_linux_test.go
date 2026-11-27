package writergate

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const (
	nativeWriterOrphanOptIn        = "FACTORY_NATIVE_WRITER_ORPHAN_PROOF"
	nativeWriterOrphanToken        = "FACTORY_NATIVE_WRITER_ORPHAN_PROOF_TOKEN"
	nativeWriterOrphanIntermediary = "factory-native-writer-orphan-intermediary"
	nativeWriterOrphanGrandchild   = "factory-native-writer-orphan-grandchild"
	nativeWriterOrphanCensusLimit  = 256
	nativeWriterOrphanLiveOptIn    = "FACTORY_NATIVE_WRITER_ORPHAN_PROOF_LIVE_SIBLING"
)

// This raw, allowlisted status deliberately permits Threads: 0. It is diagnostic
// data, NOT nativeWriterStatus or authority to skip a process in the barrier.
type nativeWriterOrphanRawStatus struct {
	PID     int    `json:"pid"`
	TGID    int    `json:"tgid"`
	PPID    int    `json:"ppid"`
	State   string `json:"state"`
	Threads int    `json:"threads"`
}

type nativeWriterOrphanRawTask struct {
	TID    int                          `json:"tid"`
	Status *nativeWriterOrphanRawStatus `json:"status"`
	Error  string                       `json:"error,omitempty"`
}

type nativeWriterOrphanRawProcess struct {
	PID      int                          `json:"pid"`
	Leader   *nativeWriterOrphanRawStatus `json:"leader"`
	TaskIDs  []int                        `json:"taskIDs"`
	Tasks    []nativeWriterOrphanRawTask  `json:"tasks"`
	Complete bool                         `json:"complete"`
	Error    string                       `json:"error,omitempty"`
	PIDFD    *nativeWriterOrphanPIDFD     `json:"pidfd,omitempty"`
}

type nativeWriterOrphanPIDFD struct {
	Events int16  `json:"events"`
	Error  string `json:"error,omitempty"`
}

type nativeWriterOrphanRawCensus struct {
	Processes []nativeWriterOrphanRawProcess `json:"processes"`
	Complete  bool                           `json:"complete"`
	Error     string                         `json:"error,omitempty"`
}

type nativeWriterOrphanState struct {
	PID                  int                         `json:"pid"`
	UID                  int                         `json:"uid"`
	GID                  int                         `json:"gid"`
	PIDNamespace         string                      `json:"pidNamespace"`
	Census               nativeWriterOrphanRawCensus `json:"census"`
	Complete             bool                        `json:"complete"`
	Quiescent            bool                        `json:"quiescent"`
	Peers                []nativeWriterProofPeer     `json:"peers"`
	Error                string                      `json:"error,omitempty"`
	OrphanAttempted      bool                        `json:"orphanAttempted"`
	IntermediaryPID      int                         `json:"intermediaryPID"`
	GrandchildPID        int                         `json:"grandchildPID"`
	GrandchildWaitStatus *uint32                     `json:"grandchildWaitStatus"`
	Orphan               *nativeWriterProofResult    `json:"orphanResult"`
	Freeze               *nativeWriterProofResult    `json:"freezeResult"`
	Resume               *nativeWriterProofResult    `json:"resumeResult"`
	LiveSiblingEnabled   bool                        `json:"liveSiblingEnabled"`
	LiveSiblingAttempted bool                        `json:"liveSiblingAttempted"`
	LiveSiblingPID       int                         `json:"liveSiblingPID"`
	LiveSibling          *nativeWriterProofResult    `json:"liveSiblingResult"`
}

type nativeWriterOrphanFixture struct {
	mutex       sync.Mutex
	proc        *os.File
	identity    Identity
	state       nativeWriterOrphanState
	liveSibling *exec.Cmd
}

func nativeWriterOrphanMode(args []string) (string, error) {
	for i, arg := range args {
		if arg != "--" {
			continue
		}
		if i == len(args)-2 && (args[i+1] == nativeWriterOrphanIntermediary || args[i+1] == nativeWriterOrphanGrandchild) {
			return args[i+1], nil
		}
		return "", errors.New("test-only orphan mode requires an exact trailing sentinel")
	}
	return "", nil
}

func nativeWriterOrphanReadFile(directory *os.File, name string) (string, error) {
	fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, nativeWriterFileLimit+1))
	if err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > nativeWriterFileLimit || data[len(data)-1] != '\n' {
		return "", errors.New("test-only raw proc file is incomplete or exceeds its bound")
	}
	return string(data), nil
}

func parseNativeWriterOrphanRawStatus(data string) (*nativeWriterOrphanRawStatus, error) {
	fail := errors.New("test-only raw process status is invalid or incomplete")
	if len(data) == 0 || len(data) > nativeWriterFileLimit || !strings.HasSuffix(data, "\n") {
		return nil, fail
	}
	status := &nativeWriterOrphanRawStatus{}
	seen := map[string]bool{}
	for _, line := range strings.Split(data, "\n") {
		key, value, found := strings.Cut(line, ":")
		switch key {
		case "Pid", "Tgid", "PPid", "State", "Threads":
		default:
			continue
		}
		if !found || seen[key] {
			return nil, fail
		}
		seen[key] = true
		value = strings.TrimSpace(value)
		if key == "State" {
			fields := strings.Fields(value)
			if len(fields) == 0 || len(fields[0]) != 1 || !strings.Contains("RSDTtZXI", fields[0]) {
				return nil, fail
			}
			status.State = fields[0] // Never return the raw name or other text.
			continue
		}
		number, err := strconv.ParseUint(value, 10, 31)
		if err != nil || strconv.FormatUint(number, 10) != value {
			return nil, fail
		}
		switch key {
		case "Pid":
			status.PID = int(number)
		case "Tgid":
			status.TGID = int(number)
		case "PPid":
			status.PPID = int(number)
		case "Threads":
			status.Threads = int(number)
		}
	}
	if len(seen) != 5 || status.PID == 0 || status.TGID == 0 {
		return nil, fail
	}
	return status, nil
}

func nativeWriterOrphanReadRawStatus(directory *os.File, pid, tgid int) (*nativeWriterOrphanRawStatus, error) {
	data, err := nativeWriterOrphanReadFile(directory, "status")
	if err != nil {
		return nil, err
	}
	status, err := parseNativeWriterOrphanRawStatus(data)
	if err == nil && (status.PID != pid || status.TGID != tgid) {
		err = errors.New("test-only raw process identity changed")
	}
	return status, err
}

func nativeWriterOrphanCensusProcess(ctx context.Context, proc *os.File, pid int, remaining *int) nativeWriterOrphanRawProcess {
	result := nativeWriterOrphanRawProcess{PID: pid, TaskIDs: []int{}, Tasks: []nativeWriterOrphanRawTask{}}
	process, err := nativeWriterOpenDirectory(proc, strconv.Itoa(pid))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer process.Close()
	// A separate raw kernel diagnostic, not authority to change production's
	// result. A real pidfd (not the proc directory FD) permits non-reaping poll.
	result.PIDFD = &nativeWriterOrphanPIDFD{}
	pidfd, pidfdErr := unix.PidfdOpen(pid, 0)
	if pidfdErr == nil {
		fds := []unix.PollFd{{Fd: int32(pidfd), Events: unix.POLLIN}}
		_, pidfdErr = unix.Poll(fds, 0)
		result.PIDFD.Events = fds[0].Revents
		unix.Close(pidfd)
	}
	if pidfdErr != nil {
		result.PIDFD.Error = pidfdErr.Error()
	}
	result.Leader, err = nativeWriterOrphanReadRawStatus(process, pid, pid)
	leaderErr := err
	if err != nil {
		result.Error = err.Error()
	}
	// Still enumerate tasks when reading/parsing the leader failed.
	task, err := nativeWriterOpenDirectory(process, "task")
	if err != nil {
		result.Error = errors.Join(leaderErr, err).Error()
		return result
	}
	defer task.Close()
	ids, err := nativeWriterIDs(task)
	if err != nil {
		result.Error = errors.Join(leaderErr, err).Error()
		return result
	}
	if leaderErr == nil && (len(ids) != result.Leader.Threads || !slices.Contains(ids, pid)) {
		result.Error = fmt.Sprintf("leader Threads=%d differs from task enumeration (count=%d, leaderPresent=%t)",
			result.Leader.Threads, len(ids), slices.Contains(ids, pid))
	}
	if len(ids) > *remaining {
		ids = ids[:*remaining]
		result.Error = "test-only raw census task limit exceeded; taskIDs truncated"
	}
	result.TaskIDs = ids
	for _, tid := range ids {
		if err := ctx.Err(); err != nil {
			result.Error = err.Error()
			break
		}
		*remaining -= 1
		observed := nativeWriterOrphanRawTask{TID: tid}
		thread, err := nativeWriterOpenDirectory(task, strconv.Itoa(tid))
		if err == nil {
			observed.Status, err = nativeWriterOrphanReadRawStatus(thread, tid, pid)
			thread.Close()
		}
		if err != nil {
			observed.Error = err.Error()
			if result.Error == "" {
				result.Error = "one or more raw task observations failed"
			}
		}
		result.Tasks = append(result.Tasks, observed)
	}
	result.Complete = result.Error == ""
	return result
}

func nativeWriterOrphanCensus(ctx context.Context, proc *os.File) nativeWriterOrphanRawCensus {
	result := nativeWriterOrphanRawCensus{Processes: []nativeWriterOrphanRawProcess{}}
	ids, err := nativeWriterIDs(proc)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if !slices.Contains(ids, 1) {
		result.Error = "test-only raw census lost PID1"
	}
	if len(ids) > nativeWriterOrphanCensusLimit {
		ids = ids[:nativeWriterOrphanCensusLimit]
		result.Error = "test-only raw census process limit exceeded; processes truncated"
	}
	remaining := nativeWriterOrphanCensusLimit
	for _, pid := range ids {
		if err := ctx.Err(); err != nil {
			result.Error = err.Error()
			break
		}
		process := nativeWriterOrphanCensusProcess(ctx, proc, pid, &remaining)
		result.Processes = append(result.Processes, process)
		if !process.Complete && result.Error == "" {
			result.Error = "one or more raw process censuses are incomplete"
		}
	}
	result.Complete = result.Error == ""
	return result
}

func (fixture *nativeWriterOrphanFixture) observe(ctx context.Context) nativeWriterOrphanState {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	state := fixture.state
	state.Census = nativeWriterOrphanCensus(ctx, fixture.proc)
	// Separate, unchanged production observation. A raw observation must never
	// repair, filter, simulate or hide this scanner's actual result/error.
	peers, complete, err := nativeWriterScan(ctx, fixture.proc, fixture.identity)
	state.Complete = err == nil && complete
	state.Quiescent = err == nil && nativeWriterQuiescent(peers, complete)
	state.Peers = []nativeWriterProofPeer{}
	for _, peer := range peers {
		state.Peers = append(state.Peers, nativeWriterProofPeer{PID: peer.pid, TID: peer.tid, State: string(peer.state)})
	}
	if err != nil {
		state.Error = err.Error()
	}
	return state
}

func nativeWriterOrphanCommand(ctx context.Context, mode string) (*exec.Cmd, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, executable, "-test.run=^TestNativeWriterOrphanProof$", "-test.timeout=9s", "--", mode)
	command.Env = []string{nativeWriterOrphanOptIn + "=1", "GOMAXPROCS=2"}
	command.Dir = "/"
	command.WaitDelay = time.Second
	return command, nil
}

// stat field 52 is the kernel's wait status. Read it without wait(2), so even
// successful observation leaves the exact adopted zombie unreaped.
func parseNativeWriterOrphanExitStatus(data string, pid int) (uint32, error) {
	fail := errors.New("test-only grandchild exit status is unreadable")
	start, end := strings.Index(data, " ("), strings.LastIndex(data, ") ")
	if len(data) > nativeWriterFileLimit || !strings.HasSuffix(data, "\n") ||
		start < 0 || end < start || data[:start] != strconv.Itoa(pid) {
		return 0, fail
	}
	fields := strings.Fields(data[end+2:])
	if len(fields) < 50 || fields[0] != "Z" || fields[1] != "1" {
		return 0, fail
	}
	status, err := strconv.ParseUint(fields[49], 10, 32)
	if err != nil || strconv.FormatUint(status, 10) != fields[49] {
		return 0, fail
	}
	return uint32(status), nil
}

func (fixture *nativeWriterOrphanFixture) orphan(ctx context.Context) error {
	// Set before any external create; retries never spawn another pair.
	fixture.state.OrphanAttempted = true
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	defer writer.Close()
	command, err := nativeWriterOrphanCommand(ctx, nativeWriterOrphanIntermediary)
	if err != nil {
		return err
	}
	command.ExtraFiles = []*os.File{writer} // Only a fixed PID report on FD3.
	if err := command.Start(); err != nil {
		return fmt.Errorf("test-only intermediary start failed: %w", err)
	}
	fixture.state.IntermediaryPID = command.Process.Pid
	writer.Close()
	waitErr := command.Wait() // Normal managed-child wait, never wait(-1).
	data, readErr := io.ReadAll(io.LimitReader(reader, 32))
	pidText := strings.TrimSuffix(string(data), "\n")
	pid, parseErr := strconv.ParseUint(pidText, 10, 31)
	if readErr != nil || parseErr != nil || string(data) != strconv.FormatUint(pid, 10)+"\n" ||
		pid <= 1 || int(pid) == fixture.state.IntermediaryPID {
		return fmt.Errorf("test-only intermediary PID report failed: %w", errors.Join(waitErr, readErr, errors.New("invalid fixed PID report")))
	}
	fixture.state.GrandchildPID = int(pid)
	if waitErr != nil {
		return fmt.Errorf("test-only intermediary exit failed: %w", waitErr)
	}
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("test-only adopted grandchild exit unconfirmed: %w", err)
		}
		// Do not hold a proc FD while waiting for exit or between probes: the
		// stimulus is an ordinary unreaped orphan, not a held proc handle.
		grandchild, err := nativeWriterOpenDirectory(fixture.proc, pidText)
		if err != nil {
			return fmt.Errorf("test-only reported grandchild unavailable: %w", err)
		}
		status, err := nativeWriterOrphanReadRawStatus(grandchild, int(pid), int(pid))
		if err != nil {
			grandchild.Close()
			return err
		}
		if status.PPID != 1 {
			grandchild.Close()
			return errors.New("test-only grandchild was not adopted by PID1")
		}
		if status.State == "Z" {
			data, err := nativeWriterOrphanReadFile(grandchild, "stat")
			grandchild.Close()
			if err != nil {
				return err
			}
			exitStatus, err := parseNativeWriterOrphanExitStatus(data, int(pid))
			if err != nil {
				return err
			}
			fixture.state.GrandchildWaitStatus = &exitStatus
			waitStatus := syscall.WaitStatus(exitStatus)
			if !waitStatus.Exited() || waitStatus.ExitStatus() != 0 {
				return fmt.Errorf("test-only fixed grandchild failed (wait status %d)", exitStatus)
			}
			return nil
		}
		grandchild.Close()
		select {
		case <-ctx.Done():
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (fixture *nativeWriterOrphanFixture) startLiveSibling(ctx, lifetime context.Context) error {
	fixture.state.LiveSiblingAttempted = true // Never retry an external create.
	command := exec.CommandContext(lifetime, "/writer-live-sibling")
	command.Env = []string{nativeWriterOrphanLiveOptIn + "=1"}
	command.Dir = "/"
	command.WaitDelay = time.Second
	if err := command.Start(); err != nil {
		return fmt.Errorf("test-only fixed live-sibling helper start failed: %w", err)
	}
	fixture.liveSibling = command
	fixture.state.LiveSiblingPID = command.Process.Pid
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("test-only live-sibling negative control unconfirmed: %w", err)
		}
		remaining := nativeWriterOrphanCensusLimit
		process := nativeWriterOrphanCensusProcess(ctx, fixture.proc, command.Process.Pid, &remaining)
		if process.Leader == nil {
			return fmt.Errorf("test-only live-sibling leader unavailable: %s", process.Error)
		}
		if process.Leader.PPID != 1 {
			return errors.New("test-only live-sibling helper no longer belongs to PID1")
		}
		if process.Leader.State == "Z" {
			if process.Leader.Threads < 2 {
				return errors.New("test-only zombie leader has no confirmed sibling thread")
			}
			if process.PIDFD == nil || process.PIDFD.Error != "" {
				return errors.New("test-only live-sibling pidfd observation failed; inspect raw census")
			}
			if process.PIDFD.Events != 0 {
				return fmt.Errorf("test-only live-sibling pidfd unexpectedly ready (revents=%d)", process.PIDFD.Events)
			}
			// This confirms only the negative-control stimulus, NOT scanner
			// completeness, successful freeze, or writer quiescence.
			return nil
		}
		select {
		case <-ctx.Done():
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (fixture *nativeWriterOrphanFixture) stopLiveSibling() error {
	command := fixture.liveSibling
	if command == nil {
		return nil
	}
	fixture.liveSibling = nil // Exactly one Kill + Wait for this owned command.
	killErr := command.Process.Kill()
	waitErr := command.Wait()
	if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
		return fmt.Errorf("test-only exact live-sibling kill failed: %w", killErr)
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() && status.Signal() == syscall.SIGKILL {
				return nil // Intentional exact-child shutdown, never a proof.
			}
		}
		return fmt.Errorf("test-only exact live-sibling wait failed: %w", waitErr)
	}
	return nil
}

func (fixture *nativeWriterOrphanFixture) cleanup() error {
	return errors.Join(fixture.stopLiveSibling(), fixture.cleanupOrphan())
}

func (fixture *nativeWriterOrphanFixture) cleanupOrphan() error {
	pid := fixture.state.GrandchildPID
	if pid <= 1 {
		return nil
	}
	deadline := time.Now().Add(time.Second)
	signalled := false
	for {
		var status unix.WaitStatus
		observed, err := unix.Wait4(pid, &status, unix.WNOHANG, nil)
		if errors.Is(err, unix.ECHILD) || (err == nil && observed == pid) {
			return nil
		}
		if err != nil {
			return err
		}
		if !signalled {
			// Only signal a still-live, exact owned child, pinned by its proc
			// FD. Already-exited children need only the exact wait above.
			grandchild, err := nativeWriterOpenDirectory(fixture.proc, strconv.Itoa(pid))
			if err != nil {
				return fmt.Errorf("test-only exact grandchild cleanup observation failed: %w", err)
			}
			err = unix.PidfdSendSignal(int(grandchild.Fd()), unix.SIGKILL, nil, 0)
			grandchild.Close()
			if err != nil && !nativeWriterVanished(err) {
				return fmt.Errorf("test-only exact grandchild cleanup signal failed: %w", err)
			}
			signalled = true
		}
		if time.Now().After(deadline) {
			return errors.New("test-only exact grandchild cleanup is unconfirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func nativeWriterOrphanAuth(token string, next http.Handler) http.Handler {
	expected := sha256.Sum256([]byte("Bearer " + token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		actual := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if len(r.Header.Values("Authorization")) != 1 || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			http.Error(w, "test-only bearer token required", http.StatusUnauthorized)
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
			http.Error(w, "test-only routes take no input", http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// TestNativeWriterOrphanProof is an opt-in TEST-ONLY native PID1 fixture.
//
// Build with CGO_ENABLED=0 GOOS=linux GOARCH=<native worker architecture>:
//
//	mise exec -- go test -p 2 -c -o /chosen/output/connector.test ./connector
//
// Run directly (NO shell/init wrapper), as UID/GID1000 with zero capabilities:
//
//	/connector.test -test.run=^TestNativeWriterOrphanProof$ -test.timeout=11m
//
// Env: FACTORY_NATIVE_WRITER_ORPHAN_PROOF=1
//
//	FACTORY_NATIVE_WRITER_ORPHAN_PROOF_TOKEN=<nonempty test-only bearer token>
//
// Authenticated port 18083: GET /health, GET /state, POST /orphan, POST /freeze,
// POST /resume. An additional FACTORY_NATIVE_WRITER_ORPHAN_PROOF_LIVE_SIBLING=1
// opts in to POST /live-sibling, spawning exactly /writer-live-sibling once.
// No request input, arbitrary commands, lifecycle calls or Source
// writes. GETs return diagnostic JSON even when the production scan fails;
// HTTP 200 is NOT a successful freeze or a native acceptance result.
//
// /orphan makes at most one fixed intermediary/grandchild pair per lifetime.
// PID1 waits the intermediary normally and deliberately does NOT reap its
// adopted exited grandchild until fixture shutdown. Main owns native execution
// and interpretation; this fixture claims no cause for the retained Stop failure.
func TestNativeWriterOrphanProof(t *testing.T) {
	if os.Getenv(nativeWriterOrphanOptIn) != "1" {
		t.Skip("test-only native orphan proof requires " + nativeWriterOrphanOptIn + "=1")
	}
	mode, err := nativeWriterOrphanMode(os.Args[1:])
	if err != nil {
		t.Fatal(err)
	}
	if mode != "" {
		nativeWriterOrphanChild(t, mode)
		return
	}
	if os.Getpid() != 1 || os.Geteuid() != 1000 || os.Getegid() != 1000 {
		t.Fatal("test-only native orphan proof requires actual container PID1, UID/GID1000")
	}
	token := os.Getenv(nativeWriterOrphanToken)
	if token == "" || len(token) > 512 || strings.IndexFunc(token, func(r rune) bool { return r < '!' || r > '~' }) >= 0 {
		t.Fatal("test-only orphan proof requires a nonempty bounded bearer token without whitespace")
	}
	// As in TestNativeProjectWriterProof: establish NNP on all existing Go
	// threads. New threads and both fixed children inherit it; CGO must be off.
	if _, _, errno := syscall.AllThreadsSyscall6(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0); errno != 0 {
		t.Fatalf("test-only no_new_privs setup failed (compile CGO_ENABLED=0): %v", errno)
	}
	identity, err := CallerIdentity()
	if err != nil {
		t.Fatal(err)
	}
	proc, err := nativeWriterOpenDirectory(nil, "/proc")
	if err != nil {
		t.Fatal(err)
	}
	defer proc.Close()
	var filesystem unix.Statfs_t
	self, selfErr := nativeWriterReadlink(proc, "self")
	if err := unix.Fstatfs(int(proc.Fd()), &filesystem); err != nil || filesystem.Type != unix.PROC_SUPER_MAGIC || selfErr != nil || self != "1" {
		t.Fatal("test-only orphan proof requires real procfs in PID1's namespace")
	}
	init, err := nativeWriterOpenDirectory(proc, "1")
	if err != nil {
		t.Fatal(err)
	}
	status, statusErr := nativeWriterReadStatus(init)
	identity.namespace, err = nativeWriterReadNamespace(init)
	init.Close()
	if err != nil || statusErr != nil || status.noNewPrivs != 1 || status.capEff != 0 {
		t.Fatal("test-only PID1 identity/privileges are unreadable or unbounded")
	}
	if err := nativeWriterValidateStatus(status, identity, 1, 1); err != nil {
		t.Fatal(err)
	}
	fixture := &nativeWriterOrphanFixture{
		proc: proc, identity: identity,
		state: nativeWriterOrphanState{
			PID: 1, UID: 1000, GID: 1000, PIDNamespace: identity.namespace,
			LiveSiblingEnabled: os.Getenv(nativeWriterOrphanLiveOptIn) == "1",
		},
	}
	defer func() {
		fixture.mutex.Lock()
		defer fixture.mutex.Unlock()
		if err := fixture.cleanup(); err != nil {
			t.Error(err)
		}
	}()
	lifetime, stopSignals := signal.NotifyContext(t.Context(), unix.SIGTERM, unix.SIGINT)
	defer stopSignals()
	ctx, cancel := context.WithTimeout(lifetime, 10*time.Minute)
	defer cancel()
	mux := http.NewServeMux()
	handler := func(operation string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !fixture.mutex.TryLock() {
				http.Error(w, "test-only fixture observation/operation already in progress", http.StatusConflict)
				return
			}
			defer fixture.mutex.Unlock()
			if ctx.Err() != nil {
				http.Error(w, "test-only fixture lifetime ended", http.StatusServiceUnavailable)
				return
			}
			code := http.StatusOK
			switch operation {
			case "orphan", "live-sibling", "freeze", "resume":
				var err error
				switch operation {
				case "orphan":
					if fixture.state.OrphanAttempted {
						code = http.StatusConflict // Preserve the first result.
						break
					}
					err = fixture.orphan(r.Context())
					fixture.state.Orphan = &nativeWriterProofResult{Confirmed: err == nil}
					if err != nil {
						fixture.state.Orphan.Error = err.Error()
					}
				case "live-sibling":
					if !fixture.state.LiveSiblingEnabled {
						http.Error(w, "test-only live-sibling helper requires "+nativeWriterOrphanLiveOptIn+"=1", http.StatusForbidden)
						return
					}
					if fixture.state.LiveSiblingAttempted {
						code = http.StatusConflict
						break
					}
					err = fixture.startLiveSibling(r.Context(), ctx)
					fixture.state.LiveSibling = &nativeWriterProofResult{Confirmed: err == nil}
					if err != nil {
						fixture.state.LiveSibling.Error = err.Error()
						if cleanupErr := fixture.stopLiveSibling(); cleanupErr != nil {
							fixture.state.LiveSibling.Error = errors.Join(err, cleanupErr).Error()
						}
					}
				case "freeze":
					err = FreezeNativeProjectWriters(r.Context())
					fixture.state.Freeze = &nativeWriterProofResult{Confirmed: err == nil}
					if err != nil {
						fixture.state.Freeze.Error = err.Error()
					}
				case "resume":
					err = ResumeNativeProjectWriters()
					fixture.state.Resume = &nativeWriterProofResult{Confirmed: err == nil}
					if err != nil {
						fixture.state.Resume.Error = err.Error()
					}
				}
				if err != nil {
					code = http.StatusConflict
				}
			}
			state := fixture.observe(r.Context())
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(state)
		}
	}
	mux.HandleFunc("GET /health", handler("health"))
	mux.HandleFunc("GET /state", handler("state"))
	mux.HandleFunc("POST /orphan", handler("orphan"))
	mux.HandleFunc("POST /live-sibling", handler("live-sibling"))
	mux.HandleFunc("POST /freeze", handler("freeze"))
	mux.HandleFunc("POST /resume", handler("resume"))
	server := &http.Server{
		Handler:           nativeWriterOrphanAuth(token, mux),
		ReadHeaderTimeout: time.Second, ReadTimeout: 2 * time.Second,
		WriteTimeout: 12 * time.Second, IdleTimeout: 5 * time.Second,
		MaxHeaderBytes: 4 << 10,
	}
	listener, err := net.Listen("tcp4", ":18083")
	if err != nil {
		t.Fatal("test-only orphan port unavailable:", err)
	}
	defer listener.Close()
	closeOnCancel := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer closeOnCancel()
	defer server.Close()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatal("test-only orphan HTTP server failed:", err)
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("test-only native orphan proof ten-minute lifetime expired")
	}
}

func nativeWriterOrphanChild(t *testing.T, mode string) {
	t.Helper()
	if os.Getpid() <= 1 || os.Geteuid() != 1000 || os.Getegid() != 1000 || os.Getenv(nativeWriterOrphanToken) != "" {
		t.Fatal("test-only fixed orphan child requires non-init UID/GID1000 without bearer inheritance")
	}
	self, err := nativeWriterOpenDirectory(nil, "/proc/"+strconv.Itoa(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	status, err := nativeWriterReadStatus(self)
	self.Close()
	if err != nil || status.noNewPrivs != 1 || status.capEff != 0 {
		t.Fatal("test-only fixed orphan child did not inherit bounded privileges")
	}
	if mode == nativeWriterOrphanGrandchild {
		time.Sleep(250 * time.Millisecond)
		return
	}
	if mode != nativeWriterOrphanIntermediary || os.Getppid() != 1 {
		t.Fatal("test-only intermediary requires its exact sentinel and PID1 parent")
	}
	report := os.NewFile(3, "test-only-grandchild-pid")
	if report == nil {
		t.Fatal("test-only intermediary PID report descriptor unavailable")
	}
	defer report.Close()
	command, err := nativeWriterOrphanCommand(context.Background(), nativeWriterOrphanGrandchild)
	if err != nil {
		t.Fatal(err)
	}
	// No ExtraFiles: the grandchild inherits neither report FD3 nor auth/env.
	if err := command.Start(); err != nil {
		t.Fatal("test-only fixed grandchild start failed:", err)
	}
	released := false
	defer func() {
		if !released {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	if _, err := fmt.Fprintf(report, "%d\n", command.Process.Pid); err != nil {
		t.Fatal("test-only fixed grandchild PID report failed:", err)
	}
	if err := command.Process.Release(); err != nil {
		t.Fatal("test-only fixed grandchild release failed:", err)
	}
	released = true // Deliberately never Wait; PID1 adopts this one fixed child.
}

func TestNativeWriterOrphanParsingComponent(t *testing.T) {
	good := "Name:\tnever returned ) secret-like name\nPid:\t24\nTgid:\t24\nPPid:\t1\nState:\tZ (zombie)\nThreads:\t0\n"
	status, err := parseNativeWriterOrphanRawStatus(good)
	if err != nil || status.PID != 24 || status.PPID != 1 || status.State != "Z" || status.Threads != 0 {
		t.Fatalf("raw zero-thread zombie observation lost: %+v %v", status, err)
	}
	encoded, err := json.Marshal(status)
	if err != nil || strings.Contains(string(encoded), "secret-like") {
		t.Fatal("raw status returned non-allowlisted text")
	}
	for _, bad := range []string{
		"", strings.TrimSuffix(good, "\n"), good + "Threads:\t1\n",
		strings.Replace(good, "Threads:\t0", "Threads:\t-1", 1),
		strings.Replace(good, "Pid:\t24", "Pid:\t024", 1),
		strings.Replace(good, "State:\tZ (zombie)", "State:\t? (unknown)", 1),
		strings.Replace(good, "PPid:\t1\n", "", 1), good + strings.Repeat("x", nativeWriterFileLimit),
	} {
		if _, err := parseNativeWriterOrphanRawStatus(bad); err == nil {
			t.Fatal("invalid/incomplete raw status was accepted")
		}
	}
	// Raw diagnostics may observe zero threads; production still rejects them.
	production := strings.Replace(nativeWriterStatusFixture(24, 24, 1, "Z (zombie)"), "Threads:\t1", "Threads:\t0", 1)
	if _, err := parseNativeWriterStatus(production); err == nil {
		t.Fatal("test fixture must not weaken the production status parser")
	}
	fields := make([]string, 50)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0], fields[1], fields[49] = "Z", "1", "256"
	stat := "24 (name ) with spaces) " + strings.Join(fields, " ") + "\n"
	if got, err := parseNativeWriterOrphanExitStatus(stat, 24); err != nil || got != 256 {
		t.Fatalf("actual kernel wait status not preserved: %d %v", got, err)
	}
	for _, bad := range []string{"", strings.TrimSuffix(stat, "\n"), strings.Replace(stat, "24 (", "25 (", 1), "24 (x) Z 1\n"} {
		if _, err := parseNativeWriterOrphanExitStatus(bad, 24); err == nil {
			t.Fatal("invalid/incomplete grandchild wait status was accepted")
		}
	}
}

func TestNativeWriterOrphanRawCensusComponent(t *testing.T) {
	root, proc, identity := nativeWriterProcFixture(t)
	init := nativeWriterStatusFixture(1, 1, 1, "S (sleeping)") + "PPid:\t0\n"
	nativeWriterWriteFixture(t, filepath.Join(root, "1/status"), init)
	nativeWriterWriteFixture(t, filepath.Join(root, "1/task/1/status"), init)
	zombie := strings.Replace(nativeWriterStatusFixture(24, 24, 1, "Z (zombie)"), "Threads:\t1", "Threads:\t0", 1) + "PPid:\t1\n"
	nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), zombie)
	nativeWriterWriteFixture(t, filepath.Join(root, "24/task/24/status"), zombie)
	nativeWriterWriteFixture(t, filepath.Join(root, "24/task/25/status"), nativeWriterStatusFixture(25, 24, 2, "S (sleeping)")+"PPid:\t1\n")
	fixture := &nativeWriterOrphanFixture{proc: proc, identity: identity}
	state := fixture.observe(t.Context())
	if len(state.Census.Processes) != 2 {
		t.Fatalf("raw process enumeration lost: %+v", state.Census)
	}
	process := state.Census.Processes[1]
	if process.Leader == nil || process.Leader.State != "Z" || process.Leader.Threads != 0 ||
		!slices.Equal(process.TaskIDs, []int{24, 25}) || len(process.Tasks) != 2 ||
		process.Tasks[0].Status == nil || process.Tasks[0].Status.State != "Z" ||
		process.Tasks[1].Status == nil || process.Tasks[1].Status.State != "S" {
		t.Fatalf("raw zombie leader/live sibling census was hidden: %+v", process)
	}
	if process.Complete || state.Census.Complete || !strings.Contains(process.Error, "Threads=0") ||
		state.Complete || state.Quiescent || !strings.Contains(state.Error, "status is invalid or incomplete") {
		t.Fatalf("raw mismatch or unchanged production error was hidden: %+v", state)
	}
	remaining := 1
	bounded := nativeWriterOrphanCensusProcess(t.Context(), proc, 24, &remaining)
	if bounded.Complete || len(bounded.TaskIDs) != 1 || len(bounded.Tasks) != 1 || remaining != 0 ||
		!strings.Contains(bounded.Error, "limit exceeded") {
		t.Fatalf("raw census task bound was not enforced: %+v", bounded)
	}
	nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), "unreadable as status\n")
	remaining = nativeWriterOrphanCensusLimit
	broken := nativeWriterOrphanCensusProcess(t.Context(), proc, 24, &remaining)
	if broken.Complete || broken.Leader != nil || len(broken.Tasks) != 2 || broken.Error == "" {
		t.Fatalf("leader parse failure suppressed independent task census: %+v", broken)
	}
}

func TestNativeWriterOrphanDispatchComponent(t *testing.T) {
	for _, mode := range []string{nativeWriterOrphanIntermediary, nativeWriterOrphanGrandchild} {
		got, err := nativeWriterOrphanMode([]string{"-test.run=^TestNativeWriterOrphanProof$", "--", mode})
		if err != nil || got != mode {
			t.Fatalf("exact trailing sentinel rejected: %q %v", got, err)
		}
	}
	for _, args := range [][]string{{"--"}, {"--", "unknown"}, {"--", nativeWriterOrphanGrandchild, "extra"}, {"--", "--", nativeWriterOrphanGrandchild}} {
		if _, err := nativeWriterOrphanMode(args); err == nil {
			t.Fatal("nonexact child dispatch accepted")
		}
	}
	if mode, err := nativeWriterOrphanMode([]string{"-test.run=^TestNativeWriterOrphanProof$"}); err != nil || mode != "" {
		t.Fatal("PID1 entry dispatch failed")
	}
	if mode, err := nativeWriterOrphanMode([]string{nativeWriterOrphanGrandchild}); err != nil || mode != "" {
		t.Fatal("bare child substring dispatched as a child")
	}
	t.Setenv(nativeWriterOrphanToken, "component-only-not-inherited")
	command, err := nativeWriterOrphanCommand(t.Context(), nativeWriterOrphanGrandchild)
	if err != nil || !slices.Equal(command.Env, []string{nativeWriterOrphanOptIn + "=1", "GOMAXPROCS=2"}) {
		t.Fatal("fixed child environment was not explicitly isolated")
	}
}

func TestNativeWriterOrphanHTTPBoundaryComponent(t *testing.T) {
	for _, test := range []struct {
		name, auth, target, body string
		chunked                  bool
		code                     int
	}{
		{"missing auth", "", "/state", "", false, http.StatusUnauthorized},
		{"wrong auth", "Bearer other", "/state", "", false, http.StatusUnauthorized},
		{"read", "Bearer component-only", "/state", "", false, http.StatusNoContent},
		{"query", "Bearer component-only", "/state?command=x", "", false, http.StatusBadRequest},
		{"empty query", "Bearer component-only", "/state?", "", false, http.StatusBadRequest},
		{"body", "Bearer component-only", "/orphan", "x", false, http.StatusBadRequest},
		{"chunked", "Bearer component-only", "/orphan", "", true, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			handler := nativeWriterOrphanAuth("component-only", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, test.target, strings.NewReader(test.body))
			if test.auth != "" {
				request.Header.Set("Authorization", test.auth)
			}
			if test.chunked {
				request.TransferEncoding = []string{"chunked"}
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.code || called != (test.code == http.StatusNoContent) {
				t.Fatalf("unexpected HTTP dispatch: code=%d called=%t", response.Code, called)
			}
		})
	}
}
