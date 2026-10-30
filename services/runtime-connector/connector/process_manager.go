package connector

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
)

type managedProcess struct {
	spec            Process
	command         *exec.Cmd
	state           string
	startedAt       time.Time
	exitCode        *int
	intentionalStop bool
	done            chan struct{}
	generation      uint64
}

type processManager struct {
	ctx         context.Context
	workspace   string
	output      io.Writer
	mutex       sync.Mutex
	control     *controlConnection
	processes   map[string]*managedProcess
	order       []string
	recent      map[string][]byte
	fatal       chan error
	development bool
	environment map[string]string
}

type managedProcessWriter struct {
	name    string
	manager *processManager
}

func newProcessManager(ctx context.Context, assignment Assignment, output io.Writer) *processManager {
	manager := &processManager{
		ctx:         ctx,
		workspace:   assignment.WorkspaceFolder,
		output:      output,
		processes:   make(map[string]*managedProcess, len(assignment.Processes)),
		order:       make([]string, 0, len(assignment.Processes)),
		recent:      make(map[string][]byte, len(assignment.Processes)),
		fatal:       make(chan error, len(assignment.Processes)),
		environment: assignment.RuntimeEnvironment,
	}
	for _, channel := range assignment.Channels {
		if channel.Kind == "ide" {
			manager.development = true
		}
	}
	for _, spec := range assignment.Processes {
		manager.processes[spec.Name] = &managedProcess{spec: spec, state: "stopped"}
		manager.order = append(manager.order, spec.Name)
	}
	return manager
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

func (manager *processManager) startAll() error {
	for _, name := range manager.order {
		if err := manager.start(name); err != nil {
			if manager.failureIsFatal(name) {
				return err
			}
		}
	}
	return nil
}

func (manager *processManager) startupFailure(assignment Assignment) error {
	for _, channel := range assignment.Channels {
		manager.mutex.Lock()
		process := manager.processes[channel.Name]
		if process == nil || process.state != "failed" {
			manager.mutex.Unlock()
			continue
		}
		summary := fmt.Sprintf("channel %q process %q failed before readiness", channel.Name, process.spec.Name)
		if process.exitCode != nil {
			summary = fmt.Sprintf("channel %q process %q exited with code %d before readiness",
				channel.Name, process.spec.Name, *process.exitCode)
		}
		retained := manager.recent[channel.Name]
		// The rolling process tail may begin inside a line or credential.
		// Reuse the complete-line rule before making a retained diagnostic.
		output := (&devcontainerFailureOutput{
			data: retained, truncated: len(retained) >= 32<<10,
		}).String()
		manager.mutex.Unlock()
		if detail := devcontainerFailureDiagnostic("", output, assignment); detail != "" {
			summary += ": " + detail
		}
		return errors.New(summary)
	}
	return nil
}

func (manager *processManager) action(name string, action string) error {
	if !isAppProcess(name) {
		return errors.New("only declared App processes can be controlled")
	}
	switch action {
	case "process-start":
		return manager.start(name)
	case "process-stop":
		return manager.stop(name)
	case "process-restart":
		if err := manager.stop(name); err != nil {
			return err
		}
		return manager.start(name)
	default:
		return errors.New("unsupported process action")
	}
}

func (manager *processManager) start(name string) error {
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil {
		manager.mutex.Unlock()
		return errors.New("declared process does not exist")
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
	process.intentionalStop = false
	process.done = make(chan struct{})
	spec := process.spec
	manager.mutex.Unlock()
	manager.emitState(name)

	command := exec.CommandContext(manager.ctx, spec.Command[0], spec.Command[1:]...)
	command.Dir = manager.workspace
	command.Env = assignedEnvironment(os.Environ(), manager.environment)
	for key, value := range spec.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	PrepareAssignedProcess(command)
	command.Cancel = func() error { StopAssignedProcess(command); return nil }
	command.WaitDelay = 3 * time.Second
	output := managedProcessWriter{name: name, manager: manager}
	command.Stdout = output
	command.Stderr = output
	if err := command.Start(); err != nil {
		manager.mutex.Lock()
		if process.generation == generation {
			process.state = "failed"
			code := -1
			process.exitCode = &code
			close(process.done)
		}
		manager.mutex.Unlock()
		manager.emitState(name)
		return fmt.Errorf("start process %q: %w", name, err)
	}

	manager.mutex.Lock()
	if process.generation != generation {
		manager.mutex.Unlock()
		StopAssignedProcess(command)
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

func (manager *processManager) wait(name string, generation uint64, command *exec.Cmd) {
	err := command.Wait()
	exitCode := command.ProcessState.ExitCode()
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil || process.generation != generation {
		manager.mutex.Unlock()
		return
	}
	intentional := process.intentionalStop
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

func (manager *processManager) stop(name string) error {
	manager.mutex.Lock()
	process := manager.processes[name]
	if process == nil {
		manager.mutex.Unlock()
		return errors.New("declared process does not exist")
	}
	if process.command == nil {
		manager.mutex.Unlock()
		if process.state == "stopped" || process.state == "failed" {
			return nil
		}
		return errors.New("process is not running")
	}
	process.intentionalStop = true
	process.state = "stopping"
	command := process.command
	done := process.done
	manager.mutex.Unlock()
	manager.emitState(name)
	TerminateAssignedProcess(command)
	select {
	case <-done:
		return nil
	case <-time.After(2 * time.Second):
		StopAssignedProcess(command)
	case <-manager.ctx.Done():
		StopAssignedProcess(command)
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

func (manager *processManager) stopAll() {
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
		StopAssignedProcess(command)
	}
}

func (manager *processManager) connect(control *controlConnection) {
	manager.mutex.Lock()
	manager.control = control
	if control == nil {
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
			_ = control.write(Message{
				Type:    "process-output",
				Process: name,
				Data:    base64.StdEncoding.EncodeToString(output),
			})
		}
	}
}

func (manager *processManager) emitState(name string) {
	manager.mutex.Lock()
	process := manager.processes[name]
	control := manager.control
	if process == nil {
		manager.mutex.Unlock()
		return
	}
	message := Message{
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
	if control != nil {
		_ = control.write(message)
	}
}

func (manager *processManager) write(name string, data []byte) error {
	manager.mutex.Lock()
	manager.recent[name] = append(manager.recent[name], data...)
	if len(manager.recent[name]) > 32<<10 {
		manager.recent[name] = append([]byte(nil), manager.recent[name][len(manager.recent[name])-(32<<10):]...)
	}
	control := manager.control
	manager.mutex.Unlock()
	encoded := base64.StdEncoding.EncodeToString(data)
	if _, err := fmt.Fprintf(manager.output, "FACTORY_PROCESS_OUTPUT %s %s\n", name, encoded); err != nil {
		return err
	}
	if control != nil {
		_ = control.write(Message{Type: "process-output", Process: name, Data: encoded})
	}
	return nil
}

func isAppProcess(name string) bool {
	return name == "app" || strings.HasPrefix(name, "app-")
}

func (manager *processManager) failureIsFatal(name string) bool {
	return !isAppProcess(name) && !(manager.development && name == "agent")
}
