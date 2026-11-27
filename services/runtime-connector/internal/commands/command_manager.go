package commands

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

const commandOutputBytes = 32 << 10
const maxConcurrentCommands = 8

type commandTail struct {
	data  []byte
	total uint64
}

func (tail *commandTail) append(data []byte) {
	tail.total += uint64(len(data))
	if len(data) >= commandOutputBytes {
		tail.data = append(tail.data[:0], data[len(data)-commandOutputBytes:]...)
		return
	}
	tail.data = append(tail.data, data...)
	if len(tail.data) > commandOutputBytes {
		tail.data = append([]byte(nil), tail.data[len(tail.data)-commandOutputBytes:]...)
	}
}

func (tail *commandTail) read(cursor uint64) ([]byte, uint64, bool) {
	start := tail.total - uint64(len(tail.data))
	lost := cursor < start
	if cursor < start {
		cursor = start
	}
	if cursor > tail.total {
		cursor = tail.total
	}
	return append([]byte(nil), tail.data[cursor-start:]...), cursor, lost
}

type workspaceCommand struct {
	view       protocol.CommandView
	definition string
	process    *exec.Cmd
	stdout     commandTail
	stderr     commandTail
	done       chan struct{}
	cancelled  bool
}

type Manager struct {
	ctx        context.Context
	assignment protocol.Assignment
	mutex      sync.Mutex
	commands   map[string]*workspaceCommand
	completed  []string
	send       func(protocol.Message) error
}

func NewManager(ctx context.Context, assignment protocol.Assignment, send func(protocol.Message) error) *Manager {
	return &Manager{ctx: ctx, assignment: assignment, commands: make(map[string]*workspaceCommand), send: send}
}

func (manager *Manager) Context() context.Context {
	return manager.ctx
}

func (manager *Manager) Start(input protocol.CommandRequest) (protocol.CommandView, error) {
	if !procutil.CommandIDPattern.MatchString(input.ID) || len(input.Digest) != 64 || input.Command == "" || len(input.Command) > 64<<10 {
		return protocol.CommandView{}, errors.New("invalid command identity or input")
	}
	if _, err := hex.DecodeString(input.Digest); err != nil {
		return protocol.CommandView{}, errors.New("invalid command digest")
	}
	if input.Cwd == "" {
		input.Cwd = manager.assignment.WorkspaceFolder
	}
	if !filepath.IsAbs(input.Cwd) || len(input.Cwd) > 4096 {
		return protocol.CommandView{}, errors.New("command working directory must be absolute")
	}
	definition, err := json.Marshal(input)
	if err != nil || len(definition) > 256<<10 {
		return protocol.CommandView{}, errors.New("invalid command definition")
	}
	hash := sha256.Sum256(definition)
	fingerprint := hex.EncodeToString(hash[:])
	manager.mutex.Lock()
	if previous := manager.commands[input.ID]; previous != nil {
		if previous.definition != fingerprint {
			manager.mutex.Unlock()
			return protocol.CommandView{}, errors.New("command identity already records different input")
		}
		view := manager.snapshot(previous, protocol.CommandRead{})
		manager.mutex.Unlock()
		return view, nil
	}
	active := 0
	for _, command := range manager.commands {
		if command.view.State == "starting" || command.view.State == "running" {
			active++
		}
	}
	if active >= maxConcurrentCommands || manager.ctx.Err() != nil {
		manager.mutex.Unlock()
		return protocol.CommandView{}, errors.New("command execution is unavailable")
	}
	shell := os.Getenv("SHELL")
	if !filepath.IsAbs(shell) {
		shell = "/bin/sh"
	}
	process := procutil.OwnedCommand(manager.ctx, shell, "-lc", input.Command)
	process.Dir = input.Cwd
	environment := procutil.AssignedEnvironment(os.Environ(), manager.assignment.RuntimeEnvironment)
	process.Env = procutil.AssignedEnvironment(environment, input.Env)
	command := &workspaceCommand{
		view:       protocol.CommandView{ID: input.ID, Digest: input.Digest, State: "starting"},
		definition: fingerprint, process: process, done: make(chan struct{}),
	}
	process.Stdout = commandOutputWriter{manager: manager, command: command}
	process.Stderr = commandOutputWriter{manager: manager, command: command, stderr: true}
	// Keep the execution key before Start. Factory separately records dispatch intent durably.
	manager.commands[input.ID] = command
	if err := manager.assignment.StartNativeWriter(process.Start); err != nil {
		command.view.State = "failed"
		command.process = nil
		command.view.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		close(command.done)
		view := manager.snapshot(command, protocol.CommandRead{})
		manager.mutex.Unlock()
		manager.publish(view)
		return view, nil
	}
	command.view.State = "running"
	command.view.PID = process.Process.Pid
	command.view.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	view := manager.snapshot(command, protocol.CommandRead{})
	manager.mutex.Unlock()
	manager.publish(view)
	go manager.wait(command)
	return view, nil
}

type commandOutputWriter struct {
	manager *Manager
	command *workspaceCommand
	stderr  bool
}

func (writer commandOutputWriter) Write(data []byte) (int, error) {
	writer.manager.mutex.Lock()
	if writer.stderr {
		writer.command.stderr.append(data)
	} else {
		writer.command.stdout.append(data)
	}
	writer.manager.mutex.Unlock()
	return len(data), nil
}

func (manager *Manager) snapshot(command *workspaceCommand, cursor protocol.CommandRead) protocol.CommandView {
	view := command.view
	var lostOut, lostErr bool
	view.Stdout, view.StdoutFrom, lostOut = command.stdout.read(cursor.Stdout)
	view.Stderr, view.StderrFrom, lostErr = command.stderr.read(cursor.Stderr)
	view.StdoutNext, view.StderrNext = command.stdout.total, command.stderr.total
	view.OutputLost = lostOut || lostErr
	if view.ExitCode != nil {
		code := *view.ExitCode
		view.ExitCode = &code
	}
	return view
}

func (manager *Manager) Read(input protocol.CommandRead) (protocol.CommandView, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	command := manager.commands[input.ID]
	if command == nil {
		return protocol.CommandView{}, errors.New("command outcome is unavailable in this runtime")
	}
	return manager.snapshot(command, input), nil
}

func (manager *Manager) wait(command *workspaceCommand) {
	_ = command.process.Wait()
	manager.mutex.Lock()
	code := command.process.ProcessState.ExitCode()
	command.view.ExitCode = &code
	command.view.State = "exited"
	if command.cancelled || manager.ctx.Err() != nil {
		command.view.State = "cancelled"
	}
	command.view.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	command.process = nil
	manager.completed = append(manager.completed, command.view.ID)
	if len(manager.completed) > 128 {
		oldest := manager.commands[manager.completed[0]]
		oldest.stdout.data, oldest.stderr.data = nil, nil
		manager.completed = manager.completed[1:]
	}
	view := manager.snapshot(command, protocol.CommandRead{})
	close(command.done)
	manager.mutex.Unlock()
	manager.publish(view)
}

func (manager *Manager) Cancel(id string) (protocol.CommandView, error) {
	manager.mutex.Lock()
	command := manager.commands[id]
	if command == nil {
		manager.mutex.Unlock()
		return protocol.CommandView{}, errors.New("command outcome is unavailable in this runtime")
	}
	if command.view.State == "running" {
		command.cancelled = true
		procutil.StopAssignedProcess(command.process)
	}
	view := manager.snapshot(command, protocol.CommandRead{})
	manager.mutex.Unlock()
	return view, nil
}

func (manager *Manager) publish(view protocol.CommandView) {
	// Transport loss never cancels an admitted command. Reconnect republishes compact state.
	view.Stdout, view.Stderr = nil, nil
	data, err := json.Marshal(view)
	if err == nil && manager.send != nil {
		count := manager.ActiveCount()
		_ = manager.send(protocol.Message{Type: "command-state", Data: string(data), CommandCount: &count})
	}
}

func (manager *Manager) ActiveCount() int {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	count := 0
	for _, command := range manager.commands {
		if command.view.State == "starting" || command.view.State == "running" {
			count++
		}
	}
	return count
}

func (manager *Manager) Reconnect() {
	manager.mutex.Lock()
	views := make([]protocol.CommandView, 0, len(manager.commands))
	for _, command := range manager.commands {
		views = append(views, manager.snapshot(command, protocol.CommandRead{}))
	}
	manager.mutex.Unlock()
	for _, view := range views {
		manager.publish(view)
	}
}

func (manager *Manager) Close() {
	manager.mutex.Lock()
	commands := make([]*workspaceCommand, 0, len(manager.commands))
	for _, command := range manager.commands {
		if command.view.State == "running" {
			command.cancelled = true
			procutil.StopAssignedProcess(command.process)
		}
		commands = append(commands, command)
	}
	manager.mutex.Unlock()
	for _, command := range commands {
		<-command.done
	}
}
