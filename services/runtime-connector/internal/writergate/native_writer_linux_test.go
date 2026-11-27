package writergate

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
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

func TestNativeProjectWriterRejectsOutsidePID1(t *testing.T) {
	if os.Getpid() == 1 {
		t.Skip("ordinary-process rejection must never exercise a PID1 signalling path")
	}
	for _, freeze := range []bool{true, false} {
		var err error
		if freeze {
			err = FreezeNativeProjectWriters(t.Context())
		} else {
			err = ResumeNativeProjectWriters()
		}
		if err == nil || !strings.Contains(err.Error(), "actual PID 1") {
			t.Fatalf("freeze=%v did not reject the real non-PID1 process: %v", freeze, err)
		}
	}
}

func TestNativeProjectWriterCallerIdentityComponent(t *testing.T) {
	for _, test := range []struct {
		name                      string
		pid, uid, gid, noNewPrivs int
		caps                      uint64
		accepted                  bool
	}{
		{"bounded-init", 1, 1000, 1000, 1, 0, true},
		{"other-non-root-init", 1, 2000, 3000, 1, 0, true},
		{"ordinary-process", os.Getpid() + 1, 1000, 1000, 1, 0, false},
		{"root-uid", 1, 0, 1000, 1, 0, false},
		{"root-gid", 1, 1000, 0, 1, 0, false},
		{"negative-uid", 1, -1, 1000, 1, 0, false},
		{"negative-gid", 1, 1000, -1, 1, 0, false},
		{"new-privileges-allowed", 1, 1000, 1000, 0, 0, false},
		{"invalid-no-new-privs", 1, 1000, 1000, 2, 0, false},
		{"effective-capability", 1, 1000, 1000, 1, 1, false},
		{"high-effective-capability", 1, 1000, 1000, 1, 1 << 40, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := nativeWriterValidateCaller(test.pid, test.uid, test.gid, test.noNewPrivs, test.caps); (err == nil) != test.accepted {
				t.Fatalf("pure identity validation accepted=%v: %v", err == nil, err)
			}
		})
	}
}

func nativeWriterStatusFixture(pid, tgid, threads int, state string) string {
	return fmt.Sprintf("Name:\tcomponent fixture ) with spaces\nState:\t%s\nTgid:\t%d\nPid:\t%d\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nThreads:\t%d\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\n", state, tgid, pid, threads)
}

func TestNativeProjectWriterTaskExitDuringEnumerationComponent(t *testing.T) {
	root := t.TempDir()
	nativeWriterWriteFixture(t, filepath.Join(root, "status"), nativeWriterStatusFixture(24, 24, 1, "T (stopped)"))
	if err := os.Mkdir(filepath.Join(root, "task"), 0700); err != nil {
		t.Fatal(err)
	}
	process, err := nativeWriterOpenDirectory(nil, root)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	identity := Identity{uid: 1000, gid: 1000}
	for _, cause := range []error{unix.ENOENT, unix.ESRCH, unix.EACCES, unix.EIO} {
		t.Run(cause.Error(), func(t *testing.T) {
			peers, complete, err := nativeWriterInspectTasks(t.Context(), process, identity, 24,
				func(*os.File) ([]int, error) {
					return nil, &os.PathError{Op: "readdirent", Path: ".", Err: cause}
				}, nil)
			if nativeWriterVanished(cause) {
				if err != nil || complete || len(peers) != 0 {
					t.Fatalf("exited task directory must require another complete scan, not fail or grant: %v %v %v", peers, complete, err)
				}
			} else if err == nil || complete {
				t.Fatal("a real procfs permission/I/O error was hidden as an exited process")
			}
		})
	}
	wrong := strings.ReplaceAll(nativeWriterStatusFixture(24, 24, 1, "T (stopped)"), "1000", "2000")
	nativeWriterWriteFixture(t, filepath.Join(root, "status"), wrong)
	called := false
	_, complete, err := nativeWriterInspectTasks(t.Context(), process, identity, 24,
		func(*os.File) ([]int, error) { called = true; return nil, unix.ENOENT }, nil)
	if err == nil || complete || called {
		t.Fatal("PID/identity substitution reached the disappearing-task exception")
	}
}

func TestNativeProjectWriterExitedOrphanTaskDirectoryComponent(t *testing.T) {
	root, proc, identity := nativeWriterProcFixture(t)
	nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), nativeWriterStatusFixture(24, 24, 1, "Z (zombie)"))
	process, err := nativeWriterOpenDirectory(proc, "24")
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	called := false
	peers, complete, err := nativeWriterInspectTasks(t.Context(), process, identity, 24,
		func(*os.File) ([]int, error) {
			return nil, &os.PathError{Op: "readdirent", Path: ".", Err: unix.ENOENT}
		}, func(pid int) (bool, error) {
			called = true
			if pid != 24 {
				t.Fatal("exit observation changed the original PID")
			}
			return true, nil
		})
	if err != nil || !called || !complete || len(peers) != 0 {
		t.Fatalf("kernel-confirmed exited orphan must not block quiescence: called=%t complete=%t peers=%v error=%v", called, complete, peers, err)
	}
}

func TestNativeProjectWriterUnconfirmedExitRemainsFencedComponent(t *testing.T) {
	for _, test := range []struct {
		name, state string
		taskError   error
		exitError   error
		exited      bool
		probe       bool
	}{
		{"live-sibling", "Z (zombie)", unix.ENOENT, nil, false, true},
		{"reaped-between-observations", "Z (zombie)", unix.ENOENT, unix.ESRCH, false, true},
		{"unsupported-pidfd", "Z (zombie)", unix.ENOENT, unix.ENOSYS, false, true},
		{"poll-permission-error", "Z (zombie)", unix.ENOENT, unix.EACCES, false, true},
		{"task-io-error", "Z (zombie)", unix.EIO, nil, true, false},
		{"live-task-race", "S (sleeping)", unix.ENOENT, nil, true, false},
		{"stopped-task-race", "T (stopped)", unix.ENOENT, nil, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, proc, identity := nativeWriterProcFixture(t)
			nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), nativeWriterStatusFixture(24, 24, 1, test.state))
			process, err := nativeWriterOpenDirectory(proc, "24")
			if err != nil {
				t.Fatal(err)
			}
			defer process.Close()
			called := false
			_, complete, err := nativeWriterInspectTasks(t.Context(), process, identity, 24,
				func(*os.File) ([]int, error) { return nil, test.taskError },
				func(int) (bool, error) { called = true; return test.exited, test.exitError })
			if complete || called != test.probe {
				t.Fatalf("unconfirmed exit changed writer authority: complete=%t probe=%t error=%v", complete, called, err)
			}
			if (test.exitError != nil && !nativeWriterVanished(test.exitError) || !nativeWriterVanished(test.taskError)) && err == nil {
				t.Fatal("real task/exit-observation failure was hidden")
			}
		})
	}
}

func TestNativeProjectWriterLivePIDFDIsNotExitProof(t *testing.T) {
	exited, err := nativeWriterProcessExited(os.Getpid())
	if err != nil || exited {
		t.Fatalf("live caller must not be kernel-confirmed exited: exited=%t error=%v", exited, err)
	}
	if exited, err := nativeWriterProcessExited(0); err == nil || exited {
		t.Fatal("invalid PID must not be exit proof")
	}
}

func TestNativeProjectWriterStatusParsingComponent(t *testing.T) {
	good := nativeWriterStatusFixture(24, 24, 1, "T (stopped)")
	for _, state := range []string{"R (running)", "S (sleeping)", "D (disk sleep)", "T (stopped)", "t (tracing stop)", "Z (zombie)", "X (dead)", "I (idle)"} {
		t.Run(state, func(t *testing.T) {
			status, err := parseNativeWriterStatus(strings.Replace(good, "T (stopped)", state, 1))
			if err != nil || status.state != state[0] || status.pid != 24 || status.tgid != 24 || status.threads != 1 ||
				status.uids != [4]uint32{1000, 1000, 1000, 1000} || status.gids != status.uids || status.capEff != 0 || status.noNewPrivs != 1 {
				t.Fatalf("valid status was not parsed exactly: %+v, %v", status, err)
			}
		})
	}
	for name, input := range map[string]string{
		"empty":                  "",
		"oversized":              good + strings.Repeat("x", nativeWriterFileLimit),
		"truncated":              strings.TrimSuffix(good, "\n"),
		"missing-state":          strings.Replace(good, "State:\tT (stopped)\n", "", 1),
		"duplicate-state":        good + "State:\tR (running)\n",
		"false-stopped-label":    strings.Replace(good, "T (stopped)", "R (stopped)", 1),
		"unknown-state":          strings.Replace(good, "T (stopped)", "? (unknown)", 1),
		"bare-state":             strings.Replace(good, "T (stopped)", "T", 1),
		"state-trailing-garbage": strings.Replace(good, "T (stopped)", "T (stopped) extra", 1),
		"state-no-colon":         strings.Replace(good, "State:", "State", 1),
		"zero-pid":               strings.Replace(good, "Pid:\t24", "Pid:\t0", 1),
		"negative-pid":           strings.Replace(good, "Pid:\t24", "Pid:\t-24", 1),
		"signed-pid":             strings.Replace(good, "Pid:\t24", "Pid:\t+24", 1),
		"pid-leading-zero":       strings.Replace(good, "Pid:\t24", "Pid:\t024", 1),
		"pid-overflow":           strings.Replace(good, "Pid:\t24", "Pid:\t2147483648", 1),
		"zero-tgid":              strings.Replace(good, "Tgid:\t24", "Tgid:\t0", 1),
		"zero-threads":           strings.Replace(good, "Threads:\t1", "Threads:\t0", 1),
		"thread-garbage":         strings.Replace(good, "Threads:\t1", "Threads:\t1 2", 1),
		"missing-nnp":            strings.Replace(good, "NoNewPrivs:\t1\n", "", 1),
		"invalid-nnp":            strings.Replace(good, "NoNewPrivs:\t1", "NoNewPrivs:\t2", 1),
		"duplicate-uid":          good + "Uid:\t1000 1000 1000 1000\n",
		"duplicate-caps":         good + "CapEff:\t0000000000000000\n",
		"short-uid":              strings.Replace(good, "Uid:\t1000\t1000\t1000\t1000", "Uid:\t1000 1000 1000", 1),
		"long-gid":               strings.Replace(good, "Gid:\t1000\t1000\t1000\t1000", "Gid:\t1000 1000 1000 1000 1000", 1),
		"negative-uid":           strings.Replace(good, "Uid:\t1000", "Uid:\t-1", 1),
		"overflow-gid":           strings.Replace(good, "Gid:\t1000", "Gid:\t4294967296", 1),
		"signed-uid":             strings.Replace(good, "Uid:\t1000", "Uid:\t+1000", 1),
		"short-caps":             strings.Replace(good, "0000000000000000", "0", 1),
		"overflow-caps":          strings.Replace(good, "0000000000000000", "10000000000000000", 1),
		"signed-caps":            strings.Replace(good, "0000000000000000", "+000000000000000", 1),
		"invalid-caps":           strings.Replace(good, "0000000000000000", "000000000000000g", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseNativeWriterStatus(input); err == nil {
				t.Fatal("invalid/incomplete process status was accepted")
			}
		})
	}
}

func TestNativeProjectWriterStatusIdentityComponent(t *testing.T) {
	status, err := parseNativeWriterStatus(nativeWriterStatusFixture(25, 24, 2, "S (sleeping)"))
	if err != nil {
		t.Fatal(err)
	}
	identity := Identity{uid: 1000, gid: 1000}
	if err := nativeWriterValidateStatus(status, identity, 25, 24); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"pid", "tgid", "uid-real", "uid-effective", "uid-saved", "uid-fs", "gid-real", "gid-effective", "gid-saved", "gid-fs"} {
		t.Run(field, func(t *testing.T) {
			changed := status
			switch field {
			case "pid":
				changed.pid++
			case "tgid":
				changed.tgid++
			default:
				index := slices.Index([]string{"real", "effective", "saved", "fs"}, strings.Split(field, "-")[1])
				if strings.HasPrefix(field, "uid") {
					changed.uids[index] = 0
				} else {
					changed.gids[index] = 2000
				}
			}
			if err := nativeWriterValidateStatus(changed, identity, 25, 24); err == nil {
				t.Fatal("unexpected process identity was accepted")
			}
		})
	}
}

func nativeWriterWriteFixture(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

func nativeWriterProcFixture(t *testing.T) (string, *os.File, Identity) {
	t.Helper()
	root := t.TempDir()
	identity := Identity{uid: 1000, gid: 1000, namespace: "pid:[4026533000]"}
	// Deliberately invalid caller status: inspection must skip all PID1 tasks.
	nativeWriterWriteFixture(t, filepath.Join(root, "1/status"), "caller is not a peer\n")
	nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), nativeWriterStatusFixture(24, 24, 2, "T (stopped)"))
	for _, tid := range []int{24, 25} {
		task := filepath.Join(root, "24/task", strconv.Itoa(tid))
		nativeWriterWriteFixture(t, filepath.Join(task, "status"), nativeWriterStatusFixture(tid, 24, 2, "T (stopped)"))
		if err := os.Mkdir(filepath.Join(task, "ns"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(identity.namespace, filepath.Join(task, "ns/pid")); err != nil {
			t.Fatal(err)
		}
	}
	proc, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proc.Close() })
	return root, proc, identity
}

// All procfs fixtures below are component evidence only: they cannot send
// signals or establish native process isolation, group-stop or fork-race proof.
func TestNativeProjectWriterProcComponentEvidence(t *testing.T) {
	for _, scenario := range []string{
		"stopped", "running-thread", "traced-thread", "zombie-thread", "zombie-leader-live-thread",
		"fork-or-thread-race", "missing-status", "unreadable-status", "invalid-status", "unexpected-uid",
		"unexpected-gid", "unexpected-tgid", "other-namespace", "invalid-namespace", "missing-namespace",
		"symlink-status", "symlink-process", "missing-init", "cancelled",
	} {
		t.Run(scenario, func(t *testing.T) {
			root, proc, identity := nativeWriterProcFixture(t)
			statusPath := filepath.Join(root, "24/task/25/status")
			namespacePath := filepath.Join(root, "24/task/25/ns/pid")
			replaceNamespace := func(value string) {
				t.Helper()
				if err := os.Remove(namespacePath); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(value, namespacePath); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			wantError, wantComplete, wantStopped := false, true, true
			switch scenario {
			case "running-thread", "traced-thread", "zombie-thread":
				state := map[string]string{"running-thread": "R (running)", "traced-thread": "t (tracing stop)", "zombie-thread": "Z (zombie)"}[scenario]
				nativeWriterWriteFixture(t, statusPath, nativeWriterStatusFixture(25, 24, 2, state))
				wantStopped = scenario == "zombie-thread"
			case "zombie-leader-live-thread":
				nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), nativeWriterStatusFixture(24, 24, 2, "Z (zombie)"))
				nativeWriterWriteFixture(t, filepath.Join(root, "24/task/24/status"), nativeWriterStatusFixture(24, 24, 2, "Z (zombie)"))
				nativeWriterWriteFixture(t, statusPath, nativeWriterStatusFixture(25, 24, 2, "S (sleeping)"))
				wantStopped = false
			case "fork-or-thread-race":
				nativeWriterWriteFixture(t, filepath.Join(root, "24/status"), nativeWriterStatusFixture(24, 24, 3, "T (stopped)"))
				wantComplete, wantStopped = false, false
			case "missing-status":
				if err := os.Remove(statusPath); err != nil {
					t.Fatal(err)
				}
				wantComplete, wantStopped = false, false
			case "unreadable-status", "symlink-status":
				if err := os.Remove(statusPath); err != nil {
					t.Fatal(err)
				}
				var err error
				if scenario == "unreadable-status" {
					err = os.Mkdir(statusPath, 0700)
				} else {
					err = os.Symlink(filepath.Join(root, "24/status"), statusPath)
				}
				if err != nil {
					t.Fatal(err)
				}
				wantError = true
			case "invalid-status":
				nativeWriterWriteFixture(t, statusPath, "State:\tT (stopped)\n")
				wantError = true
			case "unexpected-uid", "unexpected-gid", "unexpected-tgid":
				old, replacement := "Uid:\t1000", "Uid:\t0"
				if scenario == "unexpected-gid" {
					old, replacement = "Gid:\t1000", "Gid:\t0"
				} else if scenario == "unexpected-tgid" {
					old, replacement = "Tgid:\t24", "Tgid:\t25"
				}
				nativeWriterWriteFixture(t, statusPath, strings.Replace(nativeWriterStatusFixture(25, 24, 2, "T (stopped)"), old, replacement, 1))
				wantError = true
			case "other-namespace", "invalid-namespace", "missing-namespace":
				if scenario == "other-namespace" {
					replaceNamespace("pid:[4026533001]")
					wantError = true
				} else if scenario == "invalid-namespace" {
					replaceNamespace("pid:[+4026533000]")
					wantError = true
				} else {
					if err := os.Remove(namespacePath); err != nil {
						t.Fatal(err)
					}
					wantComplete, wantStopped = false, false
				}
			case "symlink-process":
				if err := os.Symlink(filepath.Join(root, "24"), filepath.Join(root, "26")); err != nil {
					t.Fatal(err)
				}
				wantError = true
			case "missing-init":
				if err := os.RemoveAll(filepath.Join(root, "1")); err != nil {
					t.Fatal(err)
				}
				wantError = true
			case "cancelled":
				cancel()
				wantError = true
			}
			peers, complete, err := nativeWriterScan(ctx, proc, identity)
			if (err != nil) != wantError {
				t.Fatalf("error=%v, expected error=%v", err, wantError)
			}
			if wantError {
				if scenario == "cancelled" && !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation lost: %v", err)
				}
				return
			}
			if complete != wantComplete || nativeWriterQuiescent(peers, complete) != wantStopped {
				t.Fatalf("incorrect quiescence: peers=%+v complete=%v", peers, complete)
			}
			again, againComplete, err := nativeWriterScan(ctx, proc, identity)
			if err != nil || againComplete != complete || !slices.Equal(peers, again) {
				t.Fatalf("repeat scan did not restart enumeration: %+v %v %v", again, againComplete, err)
			}
		})
	}
}

func TestNativeProjectWriterPIDParsingComponent(t *testing.T) {
	for _, name := range []string{"0", "01", "2147483648", "12x"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
				t.Fatal(err)
			}
			directory, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer directory.Close()
			if _, err := nativeWriterIDs(directory); err == nil {
				t.Fatal("malformed numeric proc entry was accepted")
			}
		})
	}
}

type nativeWriterProofResult struct {
	Confirmed bool   `json:"confirmed"`
	Error     string `json:"error,omitempty"`
}

type nativeWriterProofState struct {
	Role         string                   `json:"role"`
	PID          int                      `json:"pid"`
	UID          int                      `json:"uid"`
	GID          int                      `json:"gid"`
	PIDNamespace string                   `json:"pidNamespace"`
	NoNewPrivs   uint64                   `json:"noNewPrivs"`
	CapEff       uint64                   `json:"capEff"`
	WriterPID    int                      `json:"writerPID"`
	Ticks        uint64                   `json:"ticks"`
	Complete     bool                     `json:"complete"`
	Peers        []nativeWriterProofPeer  `json:"peers"`
	Freeze       *nativeWriterProofResult `json:"freezeResult"`
	Resume       *nativeWriterProofResult `json:"resumeResult"`
}

type nativeWriterProofPeer struct {
	PID   int    `json:"pid"`
	TID   int    `json:"tid"`
	State string `json:"state"`
}

func nativeWriterProofReadTicks(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	if len(data) > 32 {
		return 0, errors.New("test-only writer tick file is invalid")
	}
	return strconv.ParseUint(strings.TrimSuffix(string(data), "\n"), 10, 64)
}

func nativeWriterProofObserve(ctx context.Context, role, ticksPath string, writerPID int) (nativeWriterProofState, error) {
	state := nativeWriterProofState{Role: role, PID: os.Getpid(), UID: os.Geteuid(), GID: os.Getegid(), WriterPID: writerPID}
	identity, err := CallerIdentity()
	if err != nil {
		return state, err
	}
	proc, err := nativeWriterOpenDirectory(nil, "/proc")
	if err != nil {
		return state, err
	}
	defer proc.Close()
	init, err := nativeWriterOpenDirectory(proc, "1")
	if err != nil {
		return state, err
	}
	defer init.Close()
	identity.namespace, err = nativeWriterReadNamespace(init)
	if err != nil {
		return state, err
	}
	status, err := nativeWriterReadStatus(init)
	if err != nil {
		return state, err
	}
	state.PIDNamespace, state.NoNewPrivs, state.CapEff = identity.namespace, status.noNewPrivs, status.capEff
	peers, complete, err := nativeWriterScan(ctx, proc, identity)
	if err != nil {
		return state, err
	}
	state.Complete = complete
	writerPresent := false
	for _, peer := range peers {
		state.Peers = append(state.Peers, nativeWriterProofPeer{PID: peer.pid, TID: peer.tid, State: string(peer.state)})
		writerPresent = writerPresent || peer.pid == writerPID
	}
	if !writerPresent {
		return state, errors.New("test-only owned writer is no longer observable")
	}
	state.Ticks, err = nativeWriterProofReadTicks(ticksPath)
	return state, err
}

// TestNativeProjectWriterProof is TEST-ONLY, never part of ordinary acceptance.
// Main explicitly starts this SAME statically compiled test binary as PID1 in
// two native sibling containers (no shell/init wrapper), UID/GID1000, no caps.
//
// Opt in: FACTORY_NATIVE_WRITER_PROOF=1
// Select: FACTORY_NATIVE_WRITER_PROOF_ROLE=work|observer (fixed ports 18081|18082)
// Auth:   FACTORY_NATIVE_WRITER_PROOF_TOKEN=<nonempty test-only bearer token>
//
// GET /health and /state observe; POST /freeze and /resume call the production
// helpers only in work. Observer rejects both mutations. No execution input is
// accepted. The fixed child writes atomic monotonically increasing tick files.
// Main must demonstrate stopped work ticks/threads, still-changing observer
// ticks, and resumed work ticks; this entry alone does not assert native proof.
func TestNativeProjectWriterProof(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_WRITER_PROOF") != "1" {
		t.Skip("test-only native PID1 proof requires FACTORY_NATIVE_WRITER_PROOF=1")
	}
	if slices.Equal(os.Args[len(os.Args)-min(2, len(os.Args)):], []string{"--", "factory-native-writer-proof-child"}) {
		nativeWriterProofTickChild(t)
		return
	}
	if os.Getpid() != 1 || os.Geteuid() != 1000 || os.Getegid() != 1000 {
		t.Fatal("test-only native proof requires actual container PID1, UID/GID1000")
	}
	role := os.Getenv("FACTORY_NATIVE_WRITER_PROOF_ROLE")
	port := map[string]string{"work": "18081", "observer": "18082"}[role]
	token := os.Getenv("FACTORY_NATIVE_WRITER_PROOF_TOKEN")
	if port == "" || token == "" || strings.ContainsAny(token, "\r\n") {
		t.Fatal("test-only native proof requires a fixed role and nonempty bearer token")
	}
	// Set NNP on every existing Go thread before spawning the child or
	// serving HTTP. New Go threads and the child inherit it. CGO=0 is required,
	// as in the actual native artifact; no exec wrapper or host setup is used.
	if _, _, errno := syscall.AllThreadsSyscall6(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0); errno != 0 {
		t.Fatalf("test-only no_new_privs setup failed (compile CGO_ENABLED=0): %v", errno)
	}
	if _, err := CallerIdentity(); err != nil {
		t.Fatal(err)
	}
	lifetime, stopSignals := signal.NotifyContext(t.Context(), unix.SIGTERM, unix.SIGINT)
	defer stopSignals()
	ctx, cancel := context.WithTimeout(lifetime, 5*time.Minute)
	defer cancel()
	directory := t.TempDir()
	ticksPath := filepath.Join(directory, "ticks")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.CommandContext(ctx, executable, "-test.run=^TestNativeProjectWriterProof$", "-test.timeout=6m", "--", "factory-native-writer-proof-child")
	child.Dir = directory
	// Do not give the writer the bearer token, role, or any Factory secrets.
	child.Env = []string{"FACTORY_NATIVE_WRITER_PROOF=1", "GOMAXPROCS=2"}
	child.WaitDelay = time.Second
	if err := child.Start(); err != nil {
		t.Fatal("test-only fixed writer could not start:", err)
	}
	defer func() {
		cancel()
		_ = child.Process.Kill() // Exactly this owned child, never a PID scan.
		_ = child.Wait()
	}()
	startup := time.Now().Add(5 * time.Second)
	for {
		ticks, err := nativeWriterProofReadTicks(ticksPath)
		if err == nil && ticks > 0 {
			break
		}
		if ctx.Err() != nil || time.Now().After(startup) {
			t.Fatal("test-only writer did not produce its first tick")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var mutex sync.Mutex
	var freezeResult, resumeResult *nativeWriterProofResult
	mux := http.NewServeMux()
	handler := func(operation string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			mutex.Lock()
			defer mutex.Unlock()
			code := http.StatusOK
			if operation == "freeze" || operation == "resume" {
				if role != "work" {
					http.Error(w, "observer does not freeze or resume", http.StatusForbidden)
					return
				}
				var err error
				if operation == "freeze" {
					err = FreezeNativeProjectWriters(r.Context())
				} else {
					err = ResumeNativeProjectWriters()
				}
				result := &nativeWriterProofResult{Confirmed: err == nil}
				if err != nil {
					result.Error, code = err.Error(), http.StatusConflict
				}
				if operation == "freeze" {
					freezeResult = result
				} else {
					resumeResult = result
				}
			}
			state, err := nativeWriterProofObserve(r.Context(), role, ticksPath, child.Process.Pid)
			if err != nil {
				http.Error(w, "test-only process/tick observation failed", http.StatusServiceUnavailable)
				return
			}
			state.Freeze, state.Resume = freezeResult, resumeResult
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(state)
		}
	}
	mux.HandleFunc("GET /health", handler("health"))
	mux.HandleFunc("GET /state", handler("state"))
	mux.HandleFunc("POST /freeze", handler("freeze"))
	mux.HandleFunc("POST /resume", handler("resume"))
	expectedAuth := sha256.Sum256([]byte("Bearer " + token))
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := sha256.Sum256([]byte(r.Header.Get("Authorization")))
			if subtle.ConstantTimeCompare(auth[:], expectedAuth[:]) != 1 {
				http.Error(w, "test-only bearer token required", http.StatusUnauthorized)
				return
			}
			if r.URL.RawQuery != "" || r.ContentLength != 0 {
				http.Error(w, "test-only routes take no input", http.StatusBadRequest)
				return
			}
			mux.ServeHTTP(w, r)
		}),
		ReadHeaderTimeout: time.Second, ReadTimeout: 2 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 5 * time.Second,
		MaxHeaderBytes: 4 << 10,
	}
	listener, err := net.Listen("tcp4", ":"+port)
	if err != nil {
		t.Fatal("test-only role port unavailable:", err)
	}
	defer listener.Close()
	closeOnCancel := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer closeOnCancel()
	defer server.Close()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatal("test-only proof HTTP server failed:", err)
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("test-only native proof five-minute lifetime expired")
	}
}

func nativeWriterProofTickChild(t *testing.T) {
	t.Helper()
	if os.Getpid() <= 1 || os.Geteuid() != 1000 || os.Getegid() != 1000 {
		t.Fatal("test-only fixed writer requires an owned non-init UID/GID1000 child")
	}
	self, err := nativeWriterOpenDirectory(nil, "/proc/"+strconv.Itoa(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	status, err := nativeWriterReadStatus(self)
	self.Close()
	if err != nil || status.noNewPrivs != 1 || status.capEff != 0 {
		t.Fatal("test-only child did not inherit bounded privileges")
	}
	timer := time.NewTimer(5 * time.Minute)
	defer timer.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for ticks := uint64(1); ; ticks++ {
		if err := os.WriteFile("ticks.next", []byte(strconv.FormatUint(ticks, 10)+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename("ticks.next", "ticks"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-timer.C:
			return
		case <-t.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
