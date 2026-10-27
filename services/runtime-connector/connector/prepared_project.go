package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const preparedChildSocket = "/tmp/factory-prepared-child.sock"

// This recipe is public Project input, never a Runtime credential bundle.
func validatePreparedProject(assignment Assignment) error {
	if err := assignment.Validate(); err != nil {
		return err
	}
	if assignment.WorkspaceFolder != "/home/coder/project" ||
		assignment.RemoteWorkspaceFolder != "/workspace/project" ||
		assignment.ConnectorStateDir != "/home/coder/connector-state" ||
		assignment.PreserveWorkspace || assignment.EnvironmentVersion != nil ||
		len(assignment.RuntimeEnvironment) != 0 || assignment.EnvironmentSecretsFile != "" ||
		assignment.DockerConfigDirectory != "" || assignment.RegistryCAFile != "" ||
		assignment.Prebuild != nil || assignment.BrowserToolsImage != "" {
		return errors.New("prepared Project must be clean private source without Runtime grants")
	}
	if assignment.ControlURL != "ws://unassigned.invalid/" {
		return errors.New("prepared Project cannot retain an admitted control endpoint")
	}
	for _, channel := range assignment.Channels {
		if channel.Kind != "app" {
			return errors.New("prepared Project may start only declared Apps, not execution tools")
		}
	}
	return nil
}

func samePreparedProject(source, target Assignment) bool {
	return source.RepositoryIdentity == target.RepositoryIdentity && source.Revision == target.Revision &&
		source.DevcontainerPath == target.DevcontainerPath &&
		source.WorkspaceFolder == target.WorkspaceFolder &&
		source.RemoteWorkspaceFolder == target.RemoteWorkspaceFolder &&
		reflect.DeepEqual(source.Channels, target.Channels) && reflect.DeepEqual(source.Processes, target.Processes) &&
		!target.PreserveWorkspace && target.Prebuild == nil && target.BrowserToolsImage == ""
}

type preparedProject struct {
	assignment Assignment
	result     devcontainerResult
	origin     containerOrigin
}

func (project *preparedProject) state() parentState {
	return parentState{RuntimeAttemptID: project.assignment.RuntimeAttemptID,
		Generation: project.assignment.Generation, ContainerID: project.result.ContainerID,
		ComposeProjectName: project.result.ComposeProjectName, ContainerOrigin: &project.origin}
}

func (project *preparedProject) observe() (devcontainerResult, error) {
	container, err := inspectContainer(project.result.ContainerID)
	if err != nil {
		return devcontainerResult{}, err
	}
	owner := project.origin
	if !container.State.Running || container.ID != project.result.ContainerID ||
		container.Config.Labels[attemptLabel] != owner.AttemptID ||
		container.Config.Labels[generationLabel] != strconv.FormatUint(owner.Generation, 10) ||
		container.Config.Labels["com.docker.compose.project"] != owner.ComposeProjectName {
		return devcontainerResult{}, errors.New("prepared primary no longer has its original clean identity")
	}
	if err := validateContainerBoundary(container, project.assignment); err != nil {
		return devcontainerResult{}, err
	}
	return project.result, nil
}

func prepareReservedProject(ctx context.Context, assignment Assignment) (*preparedProject, error) {
	if err := validatePreparedProject(assignment); err != nil {
		return nil, err
	}
	// Source is imported by trusted provisioning before Start. In particular,
	// no Git transport credential is ever read by these captured processes.
	if _, err := os.Lstat(assignment.WorkspaceFolder); err != nil {
		return nil, errors.New("prepared Project requires its externally imported exact checkout")
	}
	if err := checkoutProject(ctx, assignment); err != nil {
		return nil, err
	}
	if err := prepareDevcontainerProject(ctx, assignment); err != nil {
		return nil, err
	}
	result, err := startDevcontainer(ctx, assignment)
	if err != nil {
		return nil, err
	}
	container, err := inspectContainer(result.ContainerID)
	if err != nil {
		return nil, err
	}
	project := &preparedProject{assignment: assignment, result: result,
		origin: containerOrigin{assignment.RuntimeAttemptID, assignment.Generation, container.Config.Labels["com.docker.compose.project"]}}
	childExited, err := injectPreparedChild(ctx, assignment, result)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		select {
		case <-childExited:
			return nil, errors.New("credential-free Project child exited before activation")
		default:
		}
		_, err = preparedChildCommand(ctx, result.ContainerID, "status", nil)
		if err == nil {
			return project, nil
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			return nil, errors.New("credential-free Project processes did not become ready")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func injectPreparedChild(ctx context.Context, assignment Assignment, result devcontainerResult) (<-chan error, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	child := assignment
	child.WorkspaceFolder = result.RemoteWorkspaceFolder
	content, err := json.Marshal(child)
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp("", "factory-prepared-assignment-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(content); err != nil {
		file.Close()
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	for _, artifact := range [][2]string{{executable, "/tmp/factory-prepared-connector"}, {file.Name(), "/tmp/factory-prepared-assignment.json"}} {
		if err := exec.CommandContext(ctx, "docker", "cp", artifact[0], result.ContainerID+":"+artifact[1]).Run(); err != nil {
			return nil, errors.New("prepared child artifact delivery failed")
		}
	}
	// Only the public, credential-free recipe is readable by the configured
	// remote user. Fresh Runtime tokens still arrive through the private RPC.
	if err := exec.CommandContext(ctx, "docker", "exec", result.ContainerID, "sh", "-ec",
		`chmod 0555 "$1" && chmod 0444 "$2"`, "factory-prepared-setup",
		"/tmp/factory-prepared-connector", "/tmp/factory-prepared-assignment.json").Run(); err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, "docker", "exec", "--user", result.RemoteUser, result.ContainerID,
		"/tmp/factory-prepared-connector", "prepared-child", "--assignment", "/tmp/factory-prepared-assignment.json")
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	return exited, nil
}

type preparedChildRequest struct {
	Action     string     `json:"action"`
	Assignment Assignment `json:"assignment"`
	Token      string     `json:"token"`
}

func preparedChildCommand(ctx context.Context, containerID, action string, activation *preparedChildRequest) ([]byte, error) {
	command := exec.CommandContext(ctx, "docker", "exec", "--interactive", "--user", "0", containerID,
		"/tmp/factory-prepared-connector", "prepared-control", "--action", action)
	if activation != nil {
		content, err := json.Marshal(activation)
		if err != nil {
			return nil, err
		}
		command.Stdin = strings.NewReader(string(content))
	}
	return command.Output()
}

func activatePreparedChild(ctx context.Context, assignment Assignment, result devcontainerResult, token string) error {
	child := assignment
	child.WorkspaceFolder = result.RemoteWorkspaceFolder
	_, err := preparedChildCommand(ctx, result.ContainerID, "activate",
		&preparedChildRequest{Action: "activate", Assignment: child, Token: token})
	if err != nil {
		return errors.New("prepared child activation is unconfirmed")
	}
	return nil
}

// A prepared child starts real App processes with no Factory token or control
// connection. Only a root peer inside this private container can activate it.
func RunPreparedChild(ctx context.Context, assignment Assignment) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	source := assignment
	source.WorkspaceFolder = "/home/coder/project"
	if err := validatePreparedProject(source); err != nil {
		return err
	}
	if _, err := os.Lstat(preparedChildSocket); !errors.Is(err, os.ErrNotExist) {
		return errors.New("prepared child socket already has an owner")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: preparedChildSocket, Net: "unix"})
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(preparedChildSocket, 0600); err != nil {
		return err
	}
	processes := newProcessManager(ctx, assignment, io.Discard)
	defer processes.stopAll()
	if err := processes.startAll(); err != nil {
		return err
	}
	if err := waitForChannels(ctx, assignment); err != nil {
		return err
	}
	go func() { <-ctx.Done(); listener.Close() }()
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			return err
		}
		connection.SetDeadline(time.Now().Add(10 * time.Second))
		if err := requirePreparedRootPeer(connection); err != nil {
			connection.Close()
			continue
		}
		request, err := readPreparedChildRequest(connection)
		select {
		case failure := <-processes.fatal:
			connection.Close()
			return failure
		default:
		}
		if err == nil && request.Action == "status" {
			json.NewEncoder(connection).Encode(map[string]bool{"ready": true})
			connection.Close()
			continue
		}
		if err == nil {
			err = validatePreparedChildActivation(assignment, request)
		}
		if err != nil {
			json.NewEncoder(connection).Encode(map[string]string{"error": "Prepared child activation differs from its clean Project"})
			connection.Close()
			continue
		}
		content, _ := json.Marshal(request.Assignment)
		digest := sha256.Sum256(content)
		json.NewEncoder(connection).Encode(map[string]string{"accepted": hex.EncodeToString(digest[:])})
		connection.Close()
		listener.Close()
		return runChild(ctx, request.Assignment, request.Token, processes)
	}
}

func waitPreparedDockerIdle(ctx context.Context) error {
	// A completed image pull can leave dockerd's HTTPS keep-alive sockets
	// open briefly. Wait for its own natural closure; do not close arbitrary
	// connections or weaken native checkpoint socket admission.
	deadline := time.Now().Add(105 * time.Second)
	for {
		idle, err := preparedDockerIdle()
		if err != nil {
			return err
		}
		if idle {
			return nil
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			return errors.New("private Docker image acquisition is not checkpoint-quiescent")
		}
		time.Sleep(time.Second)
	}
}

func preparedDockerIdle() (bool, error) {
	pid, err := os.ReadFile("/var/run/docker.pid")
	if err != nil {
		return false, err
	}
	value := strings.TrimSpace(string(pid))
	if parsed, err := strconv.Atoi(value); err != nil || parsed <= 1 {
		return false, errors.New("private Docker process identity is unavailable")
	}
	root := "/proc/" + value
	comm, err := os.ReadFile(root + "/comm")
	if err != nil || strings.TrimSpace(string(comm)) != "dockerd" {
		return false, errors.New("private Docker process identity changed")
	}
	entries, err := os.ReadDir(root + "/fd")
	if err != nil {
		return false, err
	}
	held := map[string]bool{}
	for _, entry := range entries {
		link, err := os.Readlink(root + "/fd/" + entry.Name())
		if err == nil && strings.HasPrefix(link, "socket:[") && strings.HasSuffix(link, "]") {
			held[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")] = true
		}
	}
	for _, family := range []string{"tcp", "tcp6"} {
		table, err := os.ReadFile(root + "/net/" + family)
		if err != nil {
			return false, err
		}
		for _, line := range strings.Split(string(table), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) >= 10 && fields[3] == "01" && held[fields[9]] {
				return false, nil
			}
		}
	}
	return true, nil
}

func validatePreparedChildActivation(source Assignment, request preparedChildRequest) error {
	if request.Action != "activate" || request.Token == "" || request.Assignment.RuntimeAttemptID == source.RuntimeAttemptID ||
		len(request.Assignment.RuntimeEnvironment) != 0 || !samePreparedProject(source, request.Assignment) {
		return errors.New("prepared child can adopt only its clean, ungranted Project processes")
	}
	return request.Assignment.Validate()
}

func ControlPreparedChild(ctx context.Context, action string, input io.Reader, output io.Writer) error {
	if action != "status" && action != "activate" {
		return errors.New("invalid prepared child operation")
	}
	request := preparedChildRequest{Action: action}
	if action == "activate" {
		var err error
		request, err = readPreparedChildRequest(input)
		if err != nil || request.Action != action {
			return errors.New("invalid private prepared child activation")
		}
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", preparedChildSocket)
	if err != nil {
		return err
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(connection).Encode(request); err != nil {
		return err
	}
	if err := connection.(*net.UnixConn).CloseWrite(); err != nil {
		return err
	}
	var response map[string]any
	if err := json.NewDecoder(io.LimitReader(connection, 4096)).Decode(&response); err != nil {
		return err
	}
	content, _ := json.Marshal(request.Assignment)
	digest := sha256.Sum256(content)
	if response["error"] != nil || (action == "status" && response["ready"] != true) ||
		(action == "activate" && response["accepted"] != hex.EncodeToString(digest[:])) {
		return fmt.Errorf("prepared child %s was refused", action)
	}
	return json.NewEncoder(output).Encode(response)
}

func readPreparedChildRequest(input io.Reader) (preparedChildRequest, error) {
	content, err := io.ReadAll(io.LimitReader(input, 1024*1024+1))
	if err != nil || len(content) > 1024*1024 {
		return preparedChildRequest{}, errors.New("prepared activation exceeds its private input bound")
	}
	var request preparedChildRequest
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return preparedChildRequest{}, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return preparedChildRequest{}, errors.New("prepared activation has trailing input")
	}
	return request, nil
}
