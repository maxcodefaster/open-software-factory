package processes

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/control"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

type managedProcess struct {
	spec            protocol.Process
	command         *exec.Cmd
	state           string
	startedAt       time.Time
	exitCode        *int
	intentionalStop bool
	done            chan struct{}
	generation      uint64
	restarts        int
	startError      string
}

type Manager struct {
	ctx         context.Context
	workspace   string
	output      io.Writer
	mutex       sync.Mutex
	control     *control.Connection
	processes   map[string]*managedProcess
	order       []string
	recent      map[string][]byte
	fatal       chan error
	development bool
	// A shared Staging or Preview runtime has App channels only. Once it is ready, a crashed App
	// restarts with a bounded backoff, because nobody opens a Run bar there.
	supervised  bool
	supervising bool
	environment map[string]string
	writers     *writergate.Gate
}

type managedProcessWriter struct {
	name    string
	manager *Manager
}

func NewManager(ctx context.Context, assignment protocol.Assignment, output io.Writer) *Manager {
	manager := &Manager{
		ctx:         ctx,
		workspace:   assignment.WorkspaceFolder,
		output:      output,
		processes:   make(map[string]*managedProcess, len(assignment.Processes)),
		order:       make([]string, 0, len(assignment.Processes)),
		recent:      make(map[string][]byte, len(assignment.Processes)),
		fatal:       make(chan error, len(assignment.Processes)),
		environment: assignment.RuntimeEnvironment,
		writers:     assignment.NativeWriters(),
	}
	manager.supervised = len(assignment.Channels) > 0
	for _, channel := range assignment.Channels {
		if channel.Kind == "ide" {
			manager.development = true
		}
		if channel.Kind != "app" {
			manager.supervised = false
		}
	}
	for _, spec := range assignment.Processes {
		manager.processes[spec.Name] = &managedProcess{spec: spec, state: "stopped"}
		manager.order = append(manager.order, spec.Name)
	}
	return manager
}

func (manager *Manager) Development() bool {
	return manager.development
}

func (manager *Manager) Fatal() <-chan error {
	return manager.fatal
}

func (manager *Manager) State(name string) (state string, exitCode *int, done <-chan struct{}) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	process := manager.processes[name]
	if process == nil {
		return "", nil, nil
	}
	if process.exitCode != nil {
		code := *process.exitCode
		exitCode = &code
	}
	return process.state, exitCode, process.done
}

func (writer managedProcessWriter) Write(data []byte) (int, error) {
	for start := 0; start < len(data); start += 24 << 10 {
		end := min(start+(24<<10), len(data))
		if err := writer.manager.write(writer.name, data[start:end]); err != nil {
			return 0, err
		}
	}
	return len(data), nil
}

func (manager *Manager) StartAll() error {
	for _, name := range manager.order {
		if err := manager.Start(name); err != nil {
			if manager.failureIsFatal(name) {
				return err
			}
		}
	}
	return nil
}

func (manager *Manager) StartupFailure(assignment protocol.Assignment) error {
	for _, channel := range assignment.Channels {
		manager.mutex.Lock()
		process := manager.processes[channel.Name]
		if process == nil || process.state != "failed" {
			manager.mutex.Unlock()
			continue
		}
		summary := fmt.Sprintf("channel %q process %q failed before readiness", channel.Name, process.spec.Name)
		if process.startError != "" {
			summary = fmt.Sprintf("channel %q process %q could not start (%s) before readiness",
				channel.Name, process.spec.Name, process.startError)
		} else if process.exitCode != nil {
			summary = fmt.Sprintf("channel %q process %q exited with code %d before readiness",
				channel.Name, process.spec.Name, *process.exitCode)
		}
		manager.mutex.Unlock()
		if detail := manager.StartupDiagnostic(channel.Name, assignment); detail != "" {
			summary += ": " + detail
		}
		return errors.New(summary)
	}
	return nil
}

func (manager *Manager) StartupDiagnostic(name string, assignment protocol.Assignment) string {
	manager.mutex.Lock()
	retained := manager.recent[name]
	// The rolling process tail may begin inside a line or credential.
	// Reuse the complete-line rule before making a retained diagnostic.
	output := (&devcontainerFailureOutput{
		data: retained, truncated: len(retained) >= 32<<10,
	}).String()
	manager.mutex.Unlock()
	if detail := DevcontainerFailureDiagnostic("", output, assignment); detail != "" {
		return detail
	}
	// A nonzero process or failed health probe is already authoritative.
	// CLI badges, version explanations and structured App logs do not need an
	// English "error" keyword to be useful. Label plain output as context.
	// Mask the complete captured output before choosing lines or trimming.
	// Either operation could otherwise remove part of a multiline credential.
	lines := strings.Split(strings.TrimSpace(maskRuntimeDiagnostic(output, assignment)), "\n")
	if len(lines) > 4 {
		lines = lines[len(lines)-4:]
	}
	if detail := compactRuntimeDiagnostic(strings.Join(lines, " ")); detail != "" {
		return "last App output: " + detail
	}
	return ""
}

func (manager *Manager) Action(name string, action string) error {
	if !isAppProcess(name) {
		return errors.New("only declared App processes can be controlled")
	}
	switch action {
	case "process-start":
		return manager.Start(name)
	case "process-stop":
		return manager.Stop(name)
	case "process-restart":
		if err := manager.Stop(name); err != nil {
			return err
		}
		return manager.Start(name)
	default:
		return errors.New("unsupported process action")
	}
}

type processStartKind uint8

const (
	explicitProcessStart processStartKind = iota
	scheduledProcessRestart
)

func (manager *Manager) Start(name string) error {
	return manager.startProcess(name, explicitProcessStart, 0)
}

func (manager *Manager) startProcess(name string, kind processStartKind, failedGeneration uint64) error {
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil {
		manager.mutex.Unlock()
		return errors.New("declared process does not exist")
	}
	// A scheduled restart owns only the failed generation that requested it. Check
	// and claim that generation together, so Stop cannot be overtaken by a timer.
	if kind == scheduledProcessRestart && (manager.ctx.Err() != nil ||
		process.generation != failedGeneration || process.state != "failed") {
		manager.mutex.Unlock()
		return nil
	}
	if process.command != nil || process.state == "starting" || process.state == "running" {
		manager.mutex.Unlock()
		return errors.New("process is already active")
	}
	process.generation++
	generation := process.generation
	process.state = "starting"
	process.startedAt = time.Time{}
	process.exitCode = nil
	process.startError = ""
	process.intentionalStop = false
	process.done = make(chan struct{})
	spec := process.spec
	manager.mutex.Unlock()
	manager.emitState(name)

	command := procutil.OwnedCommand(manager.ctx, spec.Command[0], spec.Command[1:]...)
	command.Dir = manager.workspace
	command.Env = procutil.AssignedEnvironment(os.Environ(), manager.environment)
	for key, value := range spec.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	command.WaitDelay = 3 * time.Second
	output := managedProcessWriter{name: name, manager: manager}
	command.Stdout = output
	command.Stderr = output
	if err := manager.writers.Start(command.Start); err != nil {
		manager.mutex.Lock()
		if process.generation == generation {
			process.state = "failed"
			code := -1
			process.exitCode = &code
			process.startError = err.Error()
			if len(process.startError) > 200 {
				process.startError = process.startError[:200]
			}
			close(process.done)
		}
		manager.mutex.Unlock()
		manager.emitState(name)
		return fmt.Errorf("start process %q: %w", name, err)
	}

	manager.mutex.Lock()
	if process.generation != generation {
		manager.mutex.Unlock()
		procutil.StopAssignedProcess(command)
		return errors.New("process generation changed while starting")
	}
	process.command = command
	process.state = "running"
	process.startedAt = time.Now().UTC()
	manager.mutex.Unlock()
	manager.emitState(name)
	go manager.wait(name, generation, command)
	return nil
}

func (manager *Manager) wait(name string, generation uint64, command *exec.Cmd) {
	err := command.Wait()
	exitCode := command.ProcessState.ExitCode()
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil || process.generation != generation {
		manager.mutex.Unlock()
		return
	}
	intentional := process.intentionalStop
	ranFor := time.Since(process.startedAt)
	process.command = nil
	process.exitCode = &exitCode
	if intentional || manager.ctx.Err() != nil {
		process.state = "stopped"
	} else {
		process.state = "failed"
	}
	close(process.done)
	manager.mutex.Unlock()
	manager.emitState(name)
	if !intentional && manager.ctx.Err() == nil && manager.shouldRestart(name) {
		go manager.restartAfterFailure(name, generation, ranFor)
	}
	if !intentional && manager.ctx.Err() == nil && manager.failureIsFatal(name) {
		if err == nil {
			err = fmt.Errorf("process %q exited with code %d", name, exitCode)
		} else {
			err = fmt.Errorf("process %q exited: %w", name, err)
		}
		select {
		case manager.fatal <- err:
		default:
		}
	}
}

// Supervise turns restarts on after the runtime reported its Apps ready, so a failing start is
// still reported as a start failure instead of being retried behind the caller's back.
func (manager *Manager) Supervise() {
	manager.mutex.Lock()
	manager.supervising = manager.supervised
	manager.mutex.Unlock()
}

func (manager *Manager) shouldRestart(name string) bool {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	return manager.supervising && isAppProcess(name)
}

const maximumAppRestarts = 5

func (manager *Manager) restartAfterFailure(name string, generation uint64, ranFor time.Duration) {
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil || process.generation != generation || process.state != "failed" {
		manager.mutex.Unlock()
		return
	}
	if ranFor >= time.Minute {
		process.restarts = 0
	}
	process.restarts++
	attempt := process.restarts
	manager.mutex.Unlock()
	if attempt > maximumAppRestarts {
		_ = manager.write(name, []byte("Factory stopped restarting this App after repeated failures. Restart it from the IDE.\n"))
		return
	}
	delay := min(time.Duration(1<<attempt)*time.Second, 30*time.Second)
	_ = manager.write(name, []byte(fmt.Sprintf("The App exited. Factory restarts it in %d seconds (attempt %d of %d).\n", int(delay/time.Second), attempt, maximumAppRestarts)))
	select {
	case <-manager.ctx.Done():
		return
	case <-time.After(delay):
	}
	_ = manager.startProcess(name, scheduledProcessRestart, generation)
}

func (manager *Manager) Stop(name string) error {
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil {
		manager.mutex.Unlock()
		return errors.New("declared process does not exist")
	}
	command, done := process.command, process.done
	state, generation := process.state, process.generation
	if command == nil {
		// No waiter owns a failed generation now. Retire only its pending restart,
		// without erasing the crash or invalidating an active or starting waiter.
		if state == "failed" && manager.supervising && isAppProcess(name) {
			process.generation = generation + 1
		}
		manager.mutex.Unlock()
		if state == "stopped" || state == "failed" {
			return nil
		}
		return errors.New("process is not running")
	}
	process.intentionalStop = true
	process.state = "stopping"
	manager.mutex.Unlock()
	manager.emitState(name)
	procutil.TerminateAssignedProcess(command)
	select {
	case <-done:
		return nil
	case <-time.After(2 * time.Second):
		procutil.StopAssignedProcess(command)
	case <-manager.ctx.Done():
		procutil.StopAssignedProcess(command)
		return manager.ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-manager.ctx.Done():
		return manager.ctx.Err()
	case <-time.After(3 * time.Second):
		return errors.New("process did not stop")
	}
}

func (manager *Manager) StopAll() {
	manager.mutex.Lock()
	commands := make([]*exec.Cmd, 0, len(manager.processes))
	for _, process := range manager.processes {
		if process.command != nil {
			process.intentionalStop = true
			commands = append(commands, process.command)
		}
	}
	manager.mutex.Unlock()
	for _, command := range commands {
		procutil.StopAssignedProcess(command)
	}
}

func (manager *Manager) Connect(conn *control.Connection) {
	manager.mutex.Lock()
	manager.control = conn
	if conn == nil {
		manager.mutex.Unlock()
		return
	}
	names := append([]string(nil), manager.order...)
	manager.mutex.Unlock()
	for _, name := range names {
		manager.emitState(name)
		manager.mutex.Lock()
		output := append([]byte(nil), manager.recent[name]...)
		manager.mutex.Unlock()
		if len(output) > 0 {
			_ = conn.Write(protocol.Message{
				Type:    "process-output",
				Process: name,
				Data:    base64.StdEncoding.EncodeToString(output),
			})
		}
	}
}

func (manager *Manager) emitState(name string) {
	manager.mutex.Lock()
	process := manager.processes[name]
	conn := manager.control
	if process == nil {
		manager.mutex.Unlock()
		return
	}
	message := protocol.Message{
		Type:         "process-state",
		Process:      name,
		ProcessLabel: process.spec.Label,
		ProcessState: process.state,
	}
	if !process.startedAt.IsZero() {
		message.StartedAt = process.startedAt.Format(time.RFC3339Nano)
	}
	if process.exitCode != nil {
		code := *process.exitCode
		message.ExitCode = &code
	}
	manager.mutex.Unlock()
	fmt.Fprintf(manager.output, "FACTORY_PROCESS_STATE %s %s\n", name, message.ProcessState)
	if conn != nil {
		_ = conn.Write(message)
	}
}

func (manager *Manager) WriteOutput(name string, data []byte) error {
	return manager.write(name, data)
}

func (manager *Manager) write(name string, data []byte) error {
	manager.mutex.Lock()
	manager.recent[name] = append(manager.recent[name], data...)
	if len(manager.recent[name]) > 32<<10 {
		manager.recent[name] = append([]byte(nil), manager.recent[name][len(manager.recent[name])-(32<<10):]...)
	}
	conn := manager.control
	manager.mutex.Unlock()
	encoded := base64.StdEncoding.EncodeToString(data)
	if _, err := fmt.Fprintf(manager.output, "FACTORY_PROCESS_OUTPUT %s %s\n", name, encoded); err != nil {
		return err
	}
	if conn != nil {
		_ = conn.Write(protocol.Message{Type: "process-output", Process: name, Data: encoded})
	}
	return nil
}

func isAppProcess(name string) bool {
	return name == "app" || strings.HasPrefix(name, "app-")
}

func (manager *Manager) failureIsFatal(name string) bool {
	return !isAppProcess(name) && !(manager.development && name == "agent")
}
