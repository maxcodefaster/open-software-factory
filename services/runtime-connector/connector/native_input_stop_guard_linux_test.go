package connector

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const inputStopGuardHelper = "FACTORY_NATIVE_INPUT_STOP_GUARD_HELPER"
const inputStopGuardCredentials = "FACTORY_NATIVE_INPUT_STOP_GUARD_CREDENTIAL_PROOF"

func inputStopGuardCommand(ctx context.Context, mode string) *exec.Cmd {
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeInputStopParentGuardSubprocess$", "-test.count=1")
	command.Env = []string{"PATH=/usr/bin:/bin", "GOMAXPROCS=2", inputStopGuardHelper + "=" + mode}
	if os.Getenv(inputStopGuardCredentials) == "1" {
		command.Env = append(command.Env, inputStopGuardCredentials+"=1")
	}
	if os.Getenv("FACTORY_NATIVE_INPUT_STOP_NAMESPACE_PROOF") == "1" {
		command.Env = append(command.Env, "FACTORY_NATIVE_INPUT_STOP_NAMESPACE_PROOF=1")
	}
	command.WaitDelay = time.Second
	return command
}

func runInputStopGuard(t *testing.T, mode string, file *os.File) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	command := inputStopGuardCommand(ctx, mode)
	if file != nil {
		command.ExtraFiles = []*os.File{file}
	}
	// Linux delivers PDEATHSIG when the creating OS thread exits, not just
	// when its process exits. Keep this thread alive until the child is joined.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	data, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("owned guard subprocess %s: %v: %s", mode, err, data)
	}
	return string(data)
}

func inputStopGuardPipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	return reader, writer
}

func TestNativeInputStopParentGuardRejectsUnprovedParent(t *testing.T) {
	for _, scenario := range []string{
		"nil", "closed", "regular", "directory", "device", "socket", "named-fifo",
		"write-end", "write-end-no-reader", "closed-writer", "queued-data", "data-and-closed-writer",
	} {
		t.Run(scenario, func(t *testing.T) {
			reader, writer := inputStopGuardPipe(t)
			file, mode := reader, "reject"
			switch scenario {
			case "nil":
				file, mode = nil, "reject-nil"
			case "closed":
				mode = "reject-closed"
			case "regular":
				var err error
				file, err = os.CreateTemp(t.TempDir(), "not-a-pipe-")
				if err != nil {
					t.Fatal(err)
				}
			case "directory", "device":
				path := "/dev/null"
				if scenario == "directory" {
					path = t.TempDir()
				}
				var err error
				file, err = os.Open(path)
				if err != nil {
					t.Fatal(err)
				}
			case "socket":
				pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
				if err != nil {
					t.Fatal(err)
				}
				file = os.NewFile(uintptr(pair[0]), "owned-socket")
				t.Cleanup(func() { _ = unix.Close(pair[1]) })
			case "named-fifo":
				path := filepath.Join(t.TempDir(), "not-an-anonymous-pipe")
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
				fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
				if err != nil {
					t.Fatal(err)
				}
				file = os.NewFile(uintptr(fd), "owned-named-fifo")
				peer, err := unix.Open(path, unix.O_WRONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
				if err != nil {
					_ = file.Close()
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = unix.Close(peer) })
			case "write-end", "write-end-no-reader":
				file = writer
				if scenario == "write-end-no-reader" {
					_ = reader.Close()
				}
			case "closed-writer":
				_ = writer.Close()
			case "queued-data", "data-and-closed-writer":
				if _, err := writer.Write([]byte{0x7f}); err != nil {
					t.Fatal(err)
				}
				mode = "reject-data"
				if scenario == "data-and-closed-writer" {
					_ = writer.Close()
				}
			}
			if file != nil {
				t.Cleanup(func() { _ = file.Close() })
			}
			if output := runInputStopGuard(t, mode, file); strings.TrimSpace(output) != "rejected" {
				t.Fatalf("guard rejection was not observed: %q", output)
			}
		})
	}
}

func TestNativeInputStopParentGuardLivePipeAndCloseOnExec(t *testing.T) {
	reader, _ := inputStopGuardPipe(t)
	if output := runInputStopGuard(t, "live", reader); strings.TrimSpace(output) != "armed SIGKILL; guard closed on exec" {
		t.Fatalf("live Parent guard was not preserved: %q", output)
	}
}

func TestNativeInputStopParentGuardKillsAfterParentExit(t *testing.T) {
	if output := runInputStopGuard(t, "supervise-death", nil); strings.TrimSpace(output) != "joined child killed by SIGKILL" {
		t.Fatalf("Parent death was not confirmed: %q", output)
	}
}

func TestNativeInputStopParentGuardRearmsAfterCredentialDrop(t *testing.T) {
	if os.Getenv(inputStopGuardCredentials) != "1" {
		t.Skip("explicit owned Linux SETUID/SETGID/KILL capability fixture only")
	}
	reader, _ := inputStopGuardPipe(t)
	if output := runInputStopGuard(t, "credentials", reader); strings.TrimSpace(output) != "credentials cleared PDEATHSIG; rearmed SIGKILL" {
		t.Fatalf("credential transition was not confirmed: %q", output)
	}
	if output := runInputStopGuard(t, "supervise-credential-death", nil); strings.TrimSpace(output) != "joined child killed by SIGKILL" {
		t.Fatalf("rearmed Parent death was not confirmed: %q", output)
	}
}

func inputStopGuardSignal() (int32, error) {
	var signal int32
	err := unix.Prctl(unix.PR_GET_PDEATHSIG, uintptr(unsafe.Pointer(&signal)), 0, 0, 0)
	return signal, err
}

func checkInputStopGuard(file *os.File) error {
	signal, err := inputStopGuardSignal()
	if err != nil || signal != int32(unix.SIGKILL) {
		return fmt.Errorf("PDEATHSIG readback = %d: %v", signal, err)
	}
	flags, err := unix.FcntlInt(file.Fd(), unix.F_GETFD, 0)
	if err != nil || flags&unix.FD_CLOEXEC == 0 {
		return fmt.Errorf("Parent descriptor was not close-on-exec: %v", err)
	}
	return nil
}

func dropInputStopGuardCredentials(file *os.File) error {
	if os.Getenv(inputStopGuardCredentials) != "1" || os.Geteuid() != 0 {
		return errors.New("credential proof requires explicit owned root/capability admission")
	}
	header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var capabilities [2]unix.CapUserData
	if err := unix.Capget(&header, &capabilities[0]); err != nil {
		return err
	}
	const required = (1 << unix.CAP_SETUID) | (1 << unix.CAP_SETGID) | (1 << unix.CAP_KILL)
	if capabilities[0].Effective&required != required {
		return errors.New("owned credential proof requires SETUID, SETGID and KILL")
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
	if os.Geteuid() != 1000 || os.Getegid() != 1000 {
		return errors.New("credential drop was not observed")
	}
	signal, err := inputStopGuardSignal()
	if err != nil || signal != 0 {
		return fmt.Errorf("credential drop did not clear PDEATHSIG: %d %v", signal, err)
	}
	if err := armNativeInputStopParent(file); err != nil {
		return err
	}
	return checkInputStopGuard(file)
}

// Only this separately executed process arms PDEATHSIG or changes credentials.
// It exits the process while its OS thread is still locked.
func TestNativeInputStopParentGuardSubprocess(t *testing.T) {
	mode := os.Getenv(inputStopGuardHelper)
	if mode == "" {
		return
	}
	runtime.LockOSThread()
	if err := inputStopGuardSubprocess(mode); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func inputStopGuardSubprocess(mode string) error {
	switch mode {
	case "supervise-death", "supervise-credential-death":
		return superviseInputStopGuardDeath(mode == "supervise-credential-death")
	case "death-parent", "credential-death-parent":
		return inputStopGuardDeathParent(mode == "credential-death-parent")
	case "production-parent":
		if os.Getenv("FACTORY_NATIVE_INPUT_STOP_NAMESPACE_PROOF") != "1" {
			return errors.New("production Parent proof requires its explicit private namespace fixture")
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM)
		defer cancel()
		_, err := executeNativeInputStop(ctx, ownedInputStop(), "/usr/local/bin/factory-runtime-connector")
		if err == nil {
			return errors.New("production Parent unexpectedly completed its waiting worker")
		}
		return err
	case "exec-closed":
		var info unix.Stat_t
		if err := unix.Fstat(3, &info); err == nil &&
			fmt.Sprintf("%d:%d", info.Dev, info.Ino) == os.Getenv("FACTORY_NATIVE_INPUT_STOP_GUARD_PIPE") {
			return errors.New("Parent guard pipe survived exec")
		} else if err != nil && err != unix.EBADF {
			return err
		}
		_, err := fmt.Fprintln(os.Stdout, "armed SIGKILL; guard closed on exec")
		return err
	}
	var file *os.File
	if mode != "reject-nil" {
		file = os.NewFile(3, "owned-parent-guard")
	}
	if mode == "reject-closed" {
		_ = file.Close()
	}
	if strings.HasPrefix(mode, "reject") {
		if err := armNativeInputStopParent(file); err == nil {
			return errors.New("unproved Parent liveness was accepted")
		}
		if mode == "reject-data" {
			var data [1]byte
			if _, err := io.ReadFull(file, data[:]); err != nil || data[0] != 0x7f {
				return errors.New("guard consumed or changed unexpected pipe data")
			}
		}
		_, err := fmt.Fprintln(os.Stdout, "rejected")
		return err
	}
	if flags, err := unix.FcntlInt(file.Fd(), unix.F_GETFD, 0); err != nil || flags&unix.FD_CLOEXEC != 0 {
		return errors.New("fixture did not inherit an open descriptor across exec")
	}
	if err := armNativeInputStopParent(file); err != nil {
		return err
	}
	if err := checkInputStopGuard(file); err != nil {
		return err
	}
	switch mode {
	case "credentials", "credential-death-child":
		if err := dropInputStopGuardCredentials(file); err != nil {
			return err
		}
		if mode == "credentials" {
			_, err := fmt.Fprintln(os.Stdout, "credentials cleared PDEATHSIG; rearmed SIGKILL")
			return err
		}
	case "live":
		if err := armNativeInputStopParent(file); err != nil {
			return err
		}
		if err := checkInputStopGuard(file); err != nil {
			return err
		}
		var info unix.Stat_t
		if err := unix.Fstat(int(file.Fd()), &info); err != nil {
			return err
		}
		return syscall.Exec(os.Args[0], []string{os.Args[0], "-test.run=^TestNativeInputStopParentGuardSubprocess$", "-test.count=1"},
			[]string{"PATH=/usr/bin:/bin", inputStopGuardHelper + "=exec-closed",
				fmt.Sprintf("FACTORY_NATIVE_INPUT_STOP_GUARD_PIPE=%d:%d", info.Dev, info.Ino)})
	case "death-child":
	default:
		return errors.New("unknown owned guard subprocess mode")
	}
	status := os.NewFile(4, "owned-child-status")
	if _, err := fmt.Fprintf(status, "ready %d\n", os.Getpid()); err != nil {
		return err
	}
	// The supervisor, not the dying Parent, holds this independent pipe's
	// writer. Neither guard-pipe HUP nor stdin EOF can counterfeit SIGKILL.
	var data [1]byte
	_, err := io.ReadFull(os.Stdin, data[:])
	return fmt.Errorf("independent child lifetime ended before Parent death: %v", err)
}

func inputStopGuardDeathParent(credentials bool) error {
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	defer writer.Close()
	mode := "death-child"
	if credentials {
		mode = "credential-death-child"
	}
	command := inputStopGuardCommand(context.Background(), mode)
	status := os.NewFile(3, "owned-parent-status")
	command.ExtraFiles = []*os.File{reader, status}
	command.Stdin = os.NewFile(4, "owned-independent-lifetime")
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return err
	}
	handoff := false
	defer func() {
		if !handoff {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	if _, err := fmt.Fprintf(status, "pid %d\n", command.Process.Pid); err != nil {
		return err
	}
	control, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil || control != "exit\n" {
		return fmt.Errorf("owned Parent exit was not authorized: %q %v", control, err)
	}
	handoff = true // The isolated subreaper now owns the exact child's join.
	return nil
}

func waitInputStopGuardChild(pid int, timeout time.Duration) (unix.WaitStatus, error) {
	deadline := time.Now().Add(timeout)
	for {
		var status unix.WaitStatus
		observed, err := unix.Wait4(pid, &status, unix.WNOHANG, nil)
		if err != nil && err != unix.EINTR {
			return status, err
		}
		if observed > 0 {
			return status, nil
		}
		if time.Now().After(deadline) {
			return status, errors.New("owned child was not joined before its deadline")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func superviseInputStopGuardDeath(credentials bool) (result error) {
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		return err
	}
	statusReader, statusWriter, err := os.Pipe()
	if err != nil {
		return err
	}
	defer statusReader.Close()
	defer statusWriter.Close()
	lifetimeReader, lifetimeWriter, err := os.Pipe()
	if err != nil {
		return err
	}
	defer lifetimeReader.Close()
	defer lifetimeWriter.Close()
	controlReader, controlWriter, err := os.Pipe()
	if err != nil {
		return err
	}
	defer controlReader.Close()
	defer controlWriter.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	mode := "death-parent"
	if credentials {
		mode = "credential-death-parent"
	}
	parent := inputStopGuardCommand(ctx, mode)
	parent.ExtraFiles = []*os.File{statusWriter, lifetimeReader}
	parent.Stdin = controlReader
	var diagnostic bytes.Buffer
	parent.Stderr = &diagnostic
	if err := parent.Start(); err != nil {
		return err
	}
	parentJoined, childJoined, childPID := false, false, 0
	defer func() {
		_ = controlWriter.Close()
		_ = lifetimeWriter.Close()
		if !parentJoined {
			_ = parent.Process.Kill()
			_ = parent.Wait()
		}
		if childPID > 0 && !childJoined {
			var status unix.WaitStatus
			// A waitable adopted child retains its PID until this subreaper
			// joins it. ECHILD is not authority to signal a possibly reused PID.
			if observed, err := unix.Wait4(childPID, &status, unix.WNOHANG, nil); err == nil && observed == 0 {
				_ = unix.Kill(childPID, unix.SIGKILL)
			}
		}
		// This subprocess has only its owned Parent and adopted worker. Reap
		// even an early-failing child whose PID announcement was interrupted.
		for {
			_, err := waitInputStopGuardChild(-1, 2*time.Second)
			if errors.Is(err, unix.ECHILD) {
				break
			}
			if err != nil {
				result = errors.Join(result, err)
				break
			}
		}
	}()
	_ = statusWriter.Close()
	_ = lifetimeReader.Close()
	_ = controlReader.Close()
	if err := statusReader.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
		return err
	}
	scanner := bufio.NewScanner(statusReader)
	readyPID := 0
	for childPID == 0 || readyPID == 0 {
		if !scanner.Scan() {
			return fmt.Errorf("owned child did not acknowledge arming: %v", scanner.Err())
		}
		parts := strings.Fields(scanner.Text())
		if len(parts) != 2 {
			return errors.New("invalid owned child identity record")
		}
		pid, err := strconv.Atoi(parts[1])
		if err != nil || pid <= 1 {
			return errors.New("invalid owned child PID")
		}
		switch parts[0] {
		case "pid":
			childPID = pid
		case "ready":
			readyPID = pid
		default:
			return errors.New("unexpected owned child identity record")
		}
	}
	if readyPID != childPID {
		return errors.New("Parent and armed child identities differ")
	}
	if _, err := io.WriteString(controlWriter, "exit\n"); err != nil {
		return err
	}
	if err := parent.Wait(); err != nil {
		parentJoined = true
		return fmt.Errorf("owned Parent did not exit normally: %v %s", err, diagnostic.String())
	}
	parentJoined = true
	status, err := waitInputStopGuardChild(childPID, 3*time.Second)
	if err != nil {
		return err
	}
	childJoined = true
	if !status.Signaled() || status.Signal() != unix.SIGKILL {
		return fmt.Errorf("armed child did not die from SIGKILL: %v", status)
	}
	_, err = fmt.Fprintln(os.Stdout, "joined child killed by SIGKILL")
	return err
}

type inputStopGuardProcess struct {
	pid       int
	parent    int
	startTime string
	state     string
}

func readInputStopGuardProcess(pid int) (inputStopGuardProcess, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return inputStopGuardProcess{}, err
	}
	// comm may contain spaces and parentheses. The fields after its last ')'
	// start at field 3; process starttime is field 22.
	closing := bytes.LastIndexByte(data, ')')
	if closing < 0 {
		return inputStopGuardProcess{}, errors.New("invalid owned process stat")
	}
	fields := strings.Fields(string(data[closing+1:]))
	if len(fields) < 20 {
		return inputStopGuardProcess{}, errors.New("incomplete owned process stat")
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return inputStopGuardProcess{}, err
	}
	return inputStopGuardProcess{pid: pid, parent: parent, startTime: fields[19], state: fields[0]}, nil
}

func inputStopGuardProcessRunning(owned inputStopGuardProcess) (bool, error) {
	current, err := readInputStopGuardProcess(owned.pid)
	if os.IsNotExist(err) || errors.Is(err, unix.ESRCH) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return current.startTime == owned.startTime && current.state != "Z" && current.state != "X", nil
}

func inputStopGuardDirectChild(parent inputStopGuardProcess) (inputStopGuardProcess, error) {
	current, err := readInputStopGuardProcess(parent.pid)
	if err != nil || current.startTime != parent.startTime {
		return inputStopGuardProcess{}, errors.New("owned Parent identity is no longer observable")
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return inputStopGuardProcess{}, err
	}
	var children []inputStopGuardProcess
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(status), "\n") {
			parts := strings.Fields(line)
			if len(parts) != 2 || parts[0] != "PPid:" || parts[1] != strconv.Itoa(parent.pid) {
				continue
			}
			child, err := readInputStopGuardProcess(pid)
			if err != nil || child.parent != parent.pid {
				return inputStopGuardProcess{}, errors.New("owned direct child changed during observation")
			}
			children = append(children, child)
		}
	}
	if len(children) != 1 {
		return inputStopGuardProcess{}, fmt.Errorf("owned Parent has %d direct children, expected exactly its namespace init", len(children))
	}
	return children[0], nil
}

func inputStopGuardPipeIdentity(parent inputStopGuardProcess) (string, error) {
	current, err := readInputStopGuardProcess(parent.pid)
	if err != nil || current.startTime != parent.startTime {
		return "", errors.New("owned Parent identity changed before descriptor observation")
	}
	directory := fmt.Sprintf("/proc/%d/fd", parent.pid)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", err
	}
	ends := make(map[string]int)
	for _, entry := range entries {
		link, err := os.Readlink(filepath.Join(directory, entry.Name()))
		if err != nil || !strings.HasPrefix(link, "pipe:[") {
			continue
		}
		info, err := os.ReadFile(fmt.Sprintf("/proc/%d/fdinfo/%s", parent.pid, entry.Name()))
		if err != nil {
			return "", err
		}
		for _, line := range strings.Split(string(info), "\n") {
			parts := strings.Fields(line)
			if len(parts) != 2 || parts[0] != "flags:" {
				continue
			}
			flags, err := strconv.ParseUint(parts[1], 8, 64)
			if err != nil {
				return "", err
			}
			switch flags & unix.O_ACCMODE {
			case unix.O_RDONLY:
				ends[link] |= 1
			case unix.O_WRONLY:
				ends[link] |= 2
			}
		}
	}
	var pairs []string
	for link, access := range ends {
		if access == 3 {
			pairs = append(pairs, link)
		}
	}
	if len(pairs) != 1 {
		return "", fmt.Errorf("owned Parent has %d read/write pipe identities, refusing to guess its guard", len(pairs))
	}
	return pairs[0], nil
}

// This explicit fixture owns a shadow input-stop.mjs and private .git directory.
// It makes no lifecycle/API calls. The default tests never enter these paths.
func TestNativeInputStopParentDeathBoundary(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_INPUT_STOP_NAMESPACE_PROOF") != "1" {
		t.Skip("explicit owned private namespace, shadow server and Project fixture only")
	}
	if os.Geteuid() != 0 {
		t.Fatal("owned production executor proof requires its private root")
	}
	worker := inputStopServer + "/input-stop.mjs"
	original, err := os.ReadFile(worker)
	if err != nil {
		t.Fatal(err)
	}
	originalInfo, err := os.Stat(worker)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(worker, original, originalInfo.Mode().Perm()); err != nil {
			t.Error("restore owned shadow worker:", err)
		}
	})
	directory, err := os.MkdirTemp(inputStopGit, ".factory-parent-death-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(directory); err != nil {
			t.Error("remove exact owned proof directory:", err)
		}
	})
	if err := os.Chown(directory, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	checkPipe := `
const checkGuard = () => {
  const expected = readFileSync(dir + "/guard-inode", "utf8").trim();
  if (!/^pipe:\[\d+\]$/.test(expected)) throw Error("invalid guard pipe identity");
  for (const fd of readdirSync("/proc/self/fd")) {
    let target;
    try { target = readlinkSync("/proc/self/fd/" + fd); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (target === expected) throw Error("Parent guard pipe reached Bun or its descendant");
  }
};
while (!existsSync(dir + "/guard-inode")) await Bun.sleep(10);
checkGuard();
`
	imports := `import {readFileSync,readlinkSync,readdirSync,writeFileSync,appendFileSync,existsSync} from "node:fs";` + "\n"
	childScript := imports + fmt.Sprintf("const dir = %q;\n", directory) + `
if (process.getuid() !== 1000) throw Error("wrong descendant credentials");
writeFileSync(dir + "/child-ready", "ready", {flag:"wx"});
` + checkPipe + `
writeFileSync(dir + "/child-proof", "guard absent", {flag:"wx"});
writeFileSync(dir + "/pulse", "x", {flag:"wx"});
setInterval(() => appendFileSync(dir + "/pulse", "x"), 10);
`
	script := imports + `import {spawn} from "node:child_process";` + "\n" +
		fmt.Sprintf("const dir = %q;\n", directory) + `
if (process.getuid() !== 1000 || process.pid !== 1) throw Error("wrong namespace worker identity");
` + fmt.Sprintf(`const child = spawn(process.execPath, ["--no-env-file", "-e", %q], {detached:true,stdio:"ignore",env:{PATH:"/usr/bin:/bin"}});`+"\n", childScript) + `
child.unref();
writeFileSync(dir + "/engine-ready", "ready", {flag:"wx"});
` + checkPipe + `
writeFileSync(dir + "/engine-proof", "guard absent", {flag:"wx"});
setInterval(() => {}, 1000);
await new Promise(() => {});
`
	if err := os.WriteFile(worker, []byte(script), originalInfo.Mode().Perm()); err != nil {
		t.Fatal(err)
	}
	// SIGTERM is only an early-failure cleanup path. The proof below kills
	// this actual Parent with SIGKILL after both UID 1000 processes are ready.
	parent := inputStopGuardCommand(context.Background(), "production-parent")
	var output bytes.Buffer
	parent.Stdout, parent.Stderr = &output, &output
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- parent.Wait() }()
	joined := false
	identity, identityErr := readInputStopGuardProcess(parent.Process.Pid)
	var init inputStopGuardProcess
	t.Cleanup(func() {
		if !joined {
			if init.pid == 0 && identityErr == nil {
				if child, err := inputStopGuardDirectChild(identity); err == nil {
					init = child
				}
			}
			_ = parent.Process.Signal(syscall.SIGTERM)
			select {
			case <-done:
				joined = true
			case <-time.After(5 * time.Second):
				_ = parent.Process.Kill()
				select {
				case <-done:
					joined = true
				case <-time.After(3 * time.Second):
					t.Error("owned production Parent did not join during cleanup")
				}
			}
		}
		if init.pid > 0 {
			running, err := inputStopGuardProcessRunning(init)
			if err != nil {
				t.Error("cannot observe exact owned namespace init during cleanup:", err)
			} else if running {
				// Recheck starttime immediately before the fallback kill.
				current, err := readInputStopGuardProcess(init.pid)
				if err != nil || current.startTime != init.startTime {
					t.Error("owned init identity changed; refusing fallback signal")
					return
				}
				if err := unix.Kill(init.pid, unix.SIGKILL); err != nil && err != unix.ESRCH {
					t.Error("exact owned init fallback kill:", err)
				}
				deadline := time.Now().Add(3 * time.Second)
				for {
					running, err = inputStopGuardProcessRunning(init)
					if err != nil || !running || time.Now().After(deadline) {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if err != nil || running {
					t.Error("exact owned namespace init survived fallback cleanup:", err)
				}
				t.Error("namespace init required fallback cleanup; Parent death was not safe")
			}
		}
	})
	if identityErr != nil {
		t.Fatal(identityErr)
	}
	waitFiles := func(names ...string) {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		for {
			select {
			case err := <-done:
				joined = true
				t.Fatalf("owned production Parent exited before proof: %v %s", err, output.String())
			default:
			}
			ready := true
			for _, name := range names {
				data, err := os.ReadFile(filepath.Join(directory, name))
				if err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
				ready = ready && err == nil && len(data) > 0
			}
			if ready {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("owned namespace did not publish %v", names)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitFiles("engine-ready", "child-ready")
	init, err = inputStopGuardDirectChild(identity)
	if err != nil {
		t.Fatal(err)
	}
	pipe, err := inputStopGuardPipeIdentity(identity)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(directory, "guard-inode")
	if err := os.WriteFile(marker, []byte(pipe), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(marker, 0644); err != nil {
		t.Fatal(err)
	}
	waitFiles("engine-proof", "child-proof", "pulse")
	if running, err := inputStopGuardProcessRunning(init); err != nil || !running {
		t.Fatal("recorded namespace init was not running before Parent kill:", err)
	}
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		joined = true
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("owned Parent was not killed: %v", err)
		}
		status, ok := exit.Sys().(syscall.WaitStatus)
		if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
			t.Fatalf("owned Parent did not exit from SIGKILL: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("killed production Parent was not joined")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		running, err := inputStopGuardProcessRunning(init)
		if err != nil {
			t.Fatal(err)
		}
		if !running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("namespace init survived its actual Parent's death")
		}
		time.Sleep(10 * time.Millisecond)
	}
	before, err := os.ReadFile(filepath.Join(directory, "pulse"))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	after, err := os.ReadFile(filepath.Join(directory, "pulse"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("detached UID 1000 descendant survived actual Parent death:", err)
	}
	t.Logf("Parent SIGKILL joined; init PID %d starttime %s is not running; detached pulse stopped; %s absent from Bun and descendant",
		init.pid, init.startTime, pipe)
}
