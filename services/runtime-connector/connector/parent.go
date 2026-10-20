package connector

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
	"strconv"
	"strings"
	"time"
)

const (
	attemptLabel    = "factory.dev/runtime-attempt"
	generationLabel = "factory.dev/runtime-generation"
)

var errDevcontainerNotStarted = errors.New("Dev Container start not admitted")

type devcontainerResult struct {
	Outcome               string `json:"outcome"`
	ContainerID           string `json:"containerId"`
	ComposeProjectName    string `json:"composeProjectName"`
	RemoteUser            string `json:"remoteUser"`
	RemoteWorkspaceFolder string `json:"remoteWorkspaceFolder"`
}

type parentState struct {
	RuntimeAttemptID   string `json:"runtimeAttemptId"`
	Generation         uint64 `json:"generation"`
	ContainerID        string `json:"containerId"`
	ComposeProjectName string `json:"composeProjectName"`
	PreserveWorkspace  bool   `json:"preserveWorkspace"`
}

type inspectedContainer struct {
	ID     string `json:"Id"`
	Config struct {
		Labels map[string]string `json:"Labels"`
		Image  string            `json:"Image"`
		User   string            `json:"User"`
	} `json:"Config"`
	State struct {
		Running bool `json:"Running"`
	} `json:"State"`
	HostConfig struct {
		Privileged     bool              `json:"Privileged"`
		ReadonlyRootfs bool              `json:"ReadonlyRootfs"`
		PidMode        string            `json:"PidMode"`
		IpcMode        string            `json:"IpcMode"`
		NetworkMode    string            `json:"NetworkMode"`
		UTSMode        string            `json:"UTSMode"`
		CgroupnsMode   string            `json:"CgroupnsMode"`
		CapAdd         []string          `json:"CapAdd"`
		CapDrop        []string          `json:"CapDrop"`
		Devices        []json.RawMessage `json:"Devices"`
		VolumesFrom    []string          `json:"VolumesFrom"`
		SecurityOpt    []string          `json:"SecurityOpt"`
		Tmpfs          map[string]string `json:"Tmpfs"`
		Memory         int64             `json:"Memory"`
		NanoCpus       int64             `json:"NanoCpus"`
		PidsLimit      int64             `json:"PidsLimit"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
}

func RunParent(ctx context.Context, assignment Assignment, token string, childToken string) (returnError error) {
	environment, err := readRuntimeEnvironment(ctx, assignment, token)
	if err != nil {
		return err
	}
	if assignment.EnvironmentVersion != nil {
		files, err := prepareEnvironmentFiles(environment)
		if err != nil {
			return errors.New("Runtime environment preparation failed")
		}
		defer files.cleanup()
		assignment.EnvironmentSecretsFile = files.secretsFile
		assignment.DockerConfigDirectory = files.dockerConfig
		assignment.RegistryCAFile = files.caFile
		ctx = context.WithValue(ctx, dockerConfigContextKey{}, files.dockerConfig)
		ctx = context.WithValue(ctx, registryCAContextKey{}, files.caFile)
		assignment.RuntimeEnvironment = map[string]string{}
		for _, variable := range environment.Bundle.Variables {
			if variable.Runtime {
				assignment.RuntimeEnvironment[variable.Name] = variable.Value
			}
		}
		ctx = context.WithValue(ctx, runtimeVariablesContextKey{}, assignment.RuntimeEnvironment)
		for _, registry := range environment.Bundle.Registries {
			if registry.Certificate != "" {
				directory := filepath.Join("/etc/docker/certs.d", registry.Host)
				if err := os.MkdirAll(directory, 0700); err != nil {
					return errors.New("Registry trust preparation failed")
				}
				if err := os.WriteFile(filepath.Join(directory, "ca.crt"), []byte(registry.Certificate), 0600); err != nil {
					return errors.New("Registry trust preparation failed")
				}
			}
		}
	}
	if token == "" || childToken == "" {
		return errors.New("Factory parent and child connector tokens are required")
	}
	finishDocker := startupPhase("private-docker")
	dockerErr := waitForDocker(ctx)
	// Upstream DinD mounts /tmp during startup. Create diagnostics only after
	// that mount is ready, so the daemon cannot hide an earlier measurement file.
	resetStartupTimings()
	finishDocker()
	if dockerErr != nil {
		return dockerErr
	}
	control, err := dialControl(ctx, assignment, "parent", token)
	if err != nil {
		return err
	}
	defer func() { control.close() }()
	if err := control.write(Message{
		Type:       "hello",
		Role:       "parent",
		AttemptID:  assignment.RuntimeAttemptID,
		Generation: assignment.Generation,
	}); err != nil {
		return fmt.Errorf("send parent hello: %w", err)
	}
	if err := control.write(Message{Type: "status", Phase: "starting"}); err != nil {
		return fmt.Errorf("report startup: %w", err)
	}
	finishCheckout := startupPhase("checkout")
	checkoutErr := checkoutProject(ctx, assignment)
	finishCheckout()
	if err := checkoutErr; err != nil {
		control.write(Message{Type: "status", Phase: "failed", Error: err.Error()})
		return err
	}
	if assignment.Prebuild != nil {
		bounded, cancel := context.WithTimeout(ctx, 12*time.Minute)
		defer cancel()
		platform, err := runtimePrebuildPlatform(bounded)
		var result PrebuildResult
		if err == nil {
			result, err = ProducePrebuild(bounded, assignment, PrebuildRequest{Commit: assignment.Revision, Platform: platform, ImageRepository: assignment.Prebuild.ImageRepository})
		}
		if err == nil {
			err = publishRuntimePrebuild(bounded, assignment, token, result)
		}
		if err != nil {
			control.write(Message{Type: "status", Phase: "failed", Error: err.Error()})
			return err
		}
		control.write(Message{Type: "status", Phase: "stopped"})
		return nil
	}
	if err := prepareDevcontainerProject(ctx, assignment); err != nil {
		control.write(Message{Type: "status", Phase: "failed", Error: err.Error()})
		return err
	}
	assignment.PrebuildCacheImage = compatibleRuntimePrebuild(ctx, assignment, token)
	if assignment.PrebuildCacheImage != "" {
		path, cleanup, err := preparePrebuildConsumer(ctx, assignment, assignment.PrebuildCacheImage)
		if err == nil {
			defer cleanup()
			assignment.EffectiveConfiguration = path
			if _, err := validateDevcontainer(ctx, assignment); err != nil {
				control.write(Message{Type: "status", Phase: "failed", Error: "Prepared image violates the resolved Dev Container boundary"})
				return err
			}
		}
	}
	preparation := prepareBrowserImage(ctx, func(ctx context.Context) error {
		return ensureBrowserImage(ctx, assignment.BrowserToolsImage)
	})
	defer preparation.stop()
	finishDevcontainer := startupPhase("devcontainer-start")
	result, err := startDevcontainer(ctx, assignment)
	finishDevcontainer()
	if err != nil {
		if !errors.Is(err, errDevcontainerNotStarted) {
			if cleanupErr := cleanupAttempt(assignment); cleanupErr != nil {
				err = fmt.Errorf("%w; cleanup failed: %v", err, cleanupErr)
			}
		}
		control.write(Message{Type: "status", Phase: "failed", Error: err.Error()})
		return err
	}
	state := parentState{
		RuntimeAttemptID:   assignment.RuntimeAttemptID,
		Generation:         assignment.Generation,
		ContainerID:        result.ContainerID,
		ComposeProjectName: result.ComposeProjectName,
		PreserveWorkspace:  assignment.PreserveWorkspace,
	}
	defer func() {
		if err := cleanupProject(state); err != nil && returnError == nil {
			returnError = err
			control.write(Message{Type: "status", Phase: "cleanup-failed", Error: err.Error()})
			return
		}
		_ = trimPrivateBuildCache(ctx)
		control.write(Message{Type: "status", Phase: "stopped"})
	}()
	if err := writeParentState(assignment, state); err != nil {
		return err
	}
	browser := newBrowserRuntimeManager(ctx, assignment, result.ContainerID, result.RemoteUser)
	browser.preparation = preparation
	connectionContext, disconnect := browserConnectionContext(ctx)
	defer func() {
		disconnect()
		if err := browser.closeAll(); err != nil {
			control.write(Message{Type: "status", Phase: "cleanup-failed", Error: err.Error()})
			returnError = errors.Join(returnError, err)
		}
	}()
	finishInjection := startupPhase("tool-injection")
	injectionErr := injectChild(ctx, assignment, result, childToken)
	finishInjection()
	if err := injectionErr; err != nil {
		control.write(Message{Type: "status", Phase: "failed", Error: err.Error()})
		return err
	}
	if err := announceChildStarted(ctx, assignment, token, &control); err != nil {
		return err
	}
	for {
		var message Message
		if err := control.connection.ReadJSON(&message); err != nil {
			disconnect()
			if err := browser.closeAll(); err != nil {
				return err
			}
			if ctx.Err() != nil {
				return nil
			}
			control.close()
			if err := announceChildStarted(ctx, assignment, token, &control); err != nil {
				return nil
			}
			connectionContext, disconnect = browserConnectionContext(ctx)
			continue
		}
		if message.Type == "stop" {
			control.write(Message{Type: "status", Phase: "stopping"})
			return nil
		}
		if message.Type == "operation-request" {
			if strings.HasPrefix(message.Action, "browser-") {
				captured := control
				capturedContext := connectionContext
				go func() { captured.write(browser.handle(capturedContext, message)) }()
				continue
			}
			response := handleParentOperation(ctx, assignment, message)
			if err := control.write(response); err != nil {
				// The operation may have completed. Recover the control connection,
				// never replay the operation or tear down its admitted compute.
				control.close()
			}
		}
	}
}

func announceChildStarted(ctx context.Context, assignment Assignment, token string, control **controlConnection) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := (*control).write(Message{Type: "status", Phase: "child-started"}); err == nil {
			return nil
		}
		(*control).close()
		for {
			connected, err := dialControl(ctx, assignment, "parent", token)
			if err == nil {
				if err := connected.write(Message{
					Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID,
					Generation: assignment.Generation,
				}); err == nil {
					*control = connected
					break
				}
				connected.close()
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
		}
	}
}

func handleParentOperation(ctx context.Context, assignment Assignment, message Message) Message {
	response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	if message.OperationID == "" {
		response.Error = "operation identity is required"
		return response
	}
	switch message.Action {
	case "skills-install":
		response.Error = errorText(installAdmittedSkills(ctx, assignment, message.Data))
	case "git-prepare-commit", "git-observe-commit":
		commit, err := prepareCommit(ctx, assignment.WorkspaceFolder, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.CommitSHA = commit
		}
	case "git-push":
		remote, err := pushCommit(ctx, assignment.WorkspaceFolder, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.RemoteSHA = remote
		}
	default:
		response.Error = "unsupported parent operation"
	}
	return response
}

func gitOutput(ctx context.Context, workspace string, arguments ...string) (string, error) {
	return gitOutputWithEnv(ctx, workspace, nil, arguments...)
}

func gitOutputWithEnv(ctx context.Context, workspace string, environment []string, arguments ...string) (string, error) {
	base := []string{"-c", "safe.directory=" + workspace, "-C", workspace}
	command := exec.CommandContext(ctx, "git", append(base, arguments...)...)
	if environment != nil {
		command.Env = environment
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %w: %s", arguments[0], err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func prepareCommit(ctx context.Context, workspace string, message Message) (string, error) {
	if message.OperationID == "" || message.ExpectedSHA == "" || message.CommitMessage == "" || message.AuthorName == "" || message.AuthorEmail == "" {
		return "", errors.New("commit operation is incomplete")
	}
	head, err := gitOutput(ctx, workspace, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	commitMessage := message.CommitMessage + "\n\nFactory-Operation: " + message.OperationID
	if head != message.ExpectedSHA {
		body, bodyErr := gitOutput(ctx, workspace, "show", "-s", "--format=%B", "HEAD")
		parents, parentErr := gitOutput(ctx, workspace, "show", "-s", "--format=%P", "HEAD")
		if bodyErr == nil && parentErr == nil && body == strings.TrimSpace(commitMessage) && parents == message.ExpectedSHA {
			return head, nil
		}
		return "", errors.New("workspace HEAD no longer matches the commit intent")
	}
	if message.Action == "git-observe-commit" {
		return "", errors.New("the exact prepared commit was not found; current files were not committed")
	}
	status, err := gitOutput(ctx, workspace, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if status == "" {
		return "", errors.New("workspace has no changes to commit")
	}
	if _, err := gitOutput(ctx, workspace, "add", "-A"); err != nil {
		return "", err
	}
	command := exec.CommandContext(
		ctx, "git", "-c", "safe.directory="+workspace, "-C", workspace,
		"-c", "user.name="+message.AuthorName, "-c", "user.email="+message.AuthorEmail,
		"commit", "--cleanup=verbatim", "-m", commitMessage,
	)
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git commit failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return gitOutput(ctx, workspace, "rev-parse", "HEAD")
}

func pushCommit(ctx context.Context, workspace string, message Message) (string, error) {
	if message.Branch == "" || message.ExpectedSHA == "" || message.CommitSHA == "" {
		return "", errors.New("push operation is incomplete")
	}
	head, err := gitOutput(ctx, workspace, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if head != message.CommitSHA {
		return "", errors.New("workspace HEAD no longer matches the push intent")
	}
	environment := os.Environ()
	if message.Username != "" || message.Password != "" {
		askpass, err := os.CreateTemp("", "factory-git-askpass-*")
		if err != nil {
			return "", err
		}
		askpassPath := askpass.Name()
		defer os.Remove(askpassPath)
		if _, err := askpass.WriteString("#!/bin/sh\ncase \"$1\" in *Username*) printf %s \"$FACTORY_GIT_USERNAME\";; *) printf %s \"$FACTORY_GIT_PASSWORD\";; esac\n"); err != nil {
			askpass.Close()
			return "", err
		}
		if err := askpass.Close(); err != nil {
			return "", err
		}
		if err := os.Chmod(askpassPath, 0700); err != nil {
			return "", err
		}
		environment = append(environment, "GIT_ASKPASS="+askpassPath, "GIT_TERMINAL_PROMPT=0", "FACTORY_GIT_USERNAME="+message.Username, "FACTORY_GIT_PASSWORD="+message.Password)
	}
	ref := "refs/heads/" + message.Branch
	destination := message.RepositoryURL
	if destination == "" {
		return "", errors.New("push destination is missing")
	}
	remote, err := gitOutputWithEnv(ctx, workspace, environment, "ls-remote", destination, ref)
	if err != nil {
		return "", errors.New("remote branch could not be observed")
	}
	remoteFields := strings.Fields(remote)
	remoteSHA := ""
	if len(remoteFields) > 0 {
		remoteSHA = remoteFields[0]
	}
	if remoteSHA == message.CommitSHA {
		return remoteSHA, nil
	}
	if remoteSHA != message.ExpectedSHA {
		return "", errors.New("remote branch no longer matches the push intent")
	}
	command := exec.CommandContext(
		ctx, "git", "-c", "safe.directory="+workspace, "-C", workspace,
		"push", "--porcelain", destination, message.CommitSHA+":"+ref,
	)
	command.Env = environment
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git push failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	remote, err = gitOutputWithEnv(ctx, workspace, environment, "ls-remote", destination, ref)
	if err != nil {
		return "", err
	}
	remoteFields = strings.Fields(remote)
	if len(remoteFields) == 0 || remoteFields[0] != message.CommitSHA {
		return "", errors.New("pushed commit was not observed on the remote branch")
	}
	return remoteFields[0], nil
}

func validateDevcontainer(ctx context.Context, assignment Assignment) ([]string, error) {
	return validateDevcontainerConfiguration(ctx, assignment, true)
}

func prepareDevcontainerProject(ctx context.Context, assignment Assignment) error {
	finishConfiguration := startupPhase("devcontainer-configuration")
	images, err := validateDevcontainerConfiguration(ctx, assignment, false)
	finishConfiguration()
	if err != nil {
		return err
	}
	finishImages := startupPhase("project-images")
	err = prepareProjectImages(ctx, images)
	finishImages()
	if err != nil {
		return err
	}
	// Confirmed local images supply immutable metadata to the upstream CLI.
	// Re-read mutable inputs after acquisition before permitting any container.
	finishMerged := startupPhase("devcontainer-merged-configuration")
	currentImages, err := validateDevcontainer(ctx, assignment)
	if err == nil {
		err = requirePreparedProjectImages(images, currentImages)
	}
	finishMerged()
	return err
}

func validateDevcontainerConfiguration(ctx context.Context, assignment Assignment, merged bool) ([]string, error) {
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	arguments := []string{
		"read-configuration",
		"--workspace-folder", assignment.WorkspaceFolder,
		"--config", configPath,
		"--log-format", "json",
	}
	if assignment.EffectiveConfiguration != "" {
		arguments = append(arguments, "--override-config", assignment.EffectiveConfiguration)
	}
	if assignment.RuntimeAttemptID != "" {
		arguments = append(arguments,
			"--id-label", attemptLabel+"="+assignment.RuntimeAttemptID,
			"--id-label", generationLabel+"="+strconv.FormatUint(assignment.Generation, 10),
		)
	}
	if merged {
		arguments = append(arguments, "--include-merged-configuration")
	}
	command := exec.CommandContext(ctx, "devcontainer", arguments...)
	command.Env = devcontainerEnvironment(assignment)
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("read Dev Container configuration: %w", err)
	}
	var result struct {
		Configuration struct {
			Image             string   `json:"image"`
			DockerComposeFile any      `json:"dockerComposeFile"`
			Service           string   `json:"service"`
			RunServices       []string `json:"runServices"`
			Privileged        bool     `json:"privileged"`
			Mounts            []string `json:"mounts"`
			RunArguments      []string `json:"runArgs"`
		} `json:"configuration"`
		Merged struct {
			Privileged   bool     `json:"privileged"`
			Mounts       []string `json:"mounts"`
			RunArguments []string `json:"runArgs"`
		} `json:"mergedConfiguration"`
	}
	valid := false
	for _, line := range strings.Split(string(output), "\n") {
		var candidate struct {
			Configuration json.RawMessage `json:"configuration"`
			Merged        json.RawMessage `json:"mergedConfiguration"`
		}
		if json.Unmarshal([]byte(line), &candidate) == nil && len(candidate.Configuration) > 0 && string(candidate.Configuration) != "null" && (!merged || (len(candidate.Merged) > 0 && string(candidate.Merged) != "null")) {
			if err := json.Unmarshal([]byte(line), &result); err != nil {
				return nil, fmt.Errorf("decode Dev Container configuration: %w", err)
			}
			valid = true
		}
	}
	if !valid {
		return nil, errors.New("Dev Containers CLI returned an incomplete configuration")
	}
	if result.Configuration.Privileged || result.Merged.Privileged {
		return nil, errors.New("Dev Container privileged mode is not allowed")
	}
	if err := validateRunArguments(result.Configuration.RunArguments); err != nil {
		return nil, err
	}
	if err := validateRunArguments(result.Merged.RunArguments); err != nil {
		return nil, err
	}
	for _, mount := range append(result.Configuration.Mounts, result.Merged.Mounts...) {
		if strings.Contains(mount, "/var/run/docker.sock") || strings.Contains(mount, "/factory/assignment") {
			return nil, errors.New("Dev Container cannot mount infrastructure paths")
		}
		if strings.Contains(mount, "type=bind") {
			for _, field := range strings.Split(mount, ",") {
				if strings.HasPrefix(field, "source=") || strings.HasPrefix(field, "src=") {
					source := strings.TrimPrefix(strings.TrimPrefix(field, "source="), "src=")
					if !pathWithin(assignment.WorkspaceFolder, source) {
						return nil, errors.New("Dev Container bind mounts must stay within the assigned checkout")
					}
				}
			}
		}
	}
	images, err := validateCompose(
		ctx,
		assignment,
		configPath,
		result.Configuration.DockerComposeFile,
		result.Configuration.Service,
		result.Configuration.RunServices,
	)
	if err != nil {
		return nil, err
	}
	if result.Configuration.Image != "" {
		images = append(images, result.Configuration.Image)
	}
	return images, nil
}

func validateRunArguments(arguments []string) error {
	for index, argument := range arguments {
		name, value, hasValue := strings.Cut(argument, "=")
		if !hasValue && index+1 < len(arguments) {
			value = arguments[index+1]
		}
		switch name {
		case "--privileged", "--device", "--volumes-from", "--cap-add":
			return fmt.Errorf("Dev Container run argument %q is not allowed", name)
		case "--pid", "--ipc", "--network", "--net", "--uts", "--cgroupns":
			if value == "host" || strings.HasPrefix(value, "container:") {
				return fmt.Errorf("Dev Container run argument %q crosses the assigned boundary", name)
			}
		}
	}
	return nil
}

func validateContainerBoundary(container inspectedContainer, assignment Assignment) error {
	host := container.HostConfig
	if host.Privileged || host.PidMode != "" || host.IpcMode == "host" || strings.HasPrefix(host.IpcMode, "container:") || host.NetworkMode == "host" || strings.HasPrefix(host.NetworkMode, "container:") || host.UTSMode == "host" || host.CgroupnsMode == "host" || len(host.CapAdd) > 0 || len(host.Devices) > 0 || len(host.VolumesFrom) > 0 {
		return errors.New("resolved Dev Container crosses a forbidden host boundary")
	}
	dropped := map[string]bool{}
	for _, capability := range host.CapDrop {
		dropped[strings.TrimPrefix(strings.ToUpper(capability), "CAP_")] = true
	}
	if !dropped["ALL"] && (!dropped["NET_RAW"] || !dropped["SYS_PTRACE"]) {
		return errors.New("resolved Dev Container must drop NET_RAW and SYS_PTRACE")
	}
	for _, mount := range container.Mounts {
		if mount.Destination == "/var/run/docker.sock" || mount.Destination == "/factory/assignment" || strings.Contains(mount.Source, "docker.sock") {
			return errors.New("resolved Dev Container mounts infrastructure paths")
		}
		if mount.Type == "bind" && !pathWithin(assignment.WorkspaceFolder, mount.Source) {
			return errors.New("resolved Dev Container bind mount leaves the assigned checkout")
		}
	}
	return nil
}

func validateCompose(
	ctx context.Context,
	assignment Assignment,
	configPath string,
	dockerComposeFile any,
	primaryService string,
	runServices []string,
) ([]string, error) {
	var files []string
	switch value := dockerComposeFile.(type) {
	case string:
		files = []string{value}
	case []any:
		for _, item := range value {
			if file, ok := item.(string); ok {
				files = append(files, file)
			}
		}
	}
	if len(files) == 0 {
		return nil, nil
	}
	arguments := []string{"compose"}
	for _, file := range files {
		arguments = append(arguments, "--file", filepath.Join(filepath.Dir(configPath), file))
	}
	arguments = append(arguments, "--profile", "*", "config", "--format", "json")
	output, err := runtimeDockerCommand(ctx, arguments...).Output()
	if err != nil {
		return nil, fmt.Errorf("resolve Compose configuration: %w", err)
	}
	var compose struct {
		Services map[string]struct {
			Image       string                     `json:"image"`
			Build       json.RawMessage            `json:"build"`
			Profiles    []string                   `json:"profiles"`
			DependsOn   map[string]json.RawMessage `json:"depends_on"`
			Privileged  bool                       `json:"privileged"`
			Pid         string                     `json:"pid"`
			NetworkMode string                     `json:"network_mode"`
			CapDrop     []string                   `json:"cap_drop"`
			Volumes     []struct {
				Type   string `json:"type"`
				Source string `json:"source"`
				Target string `json:"target"`
			} `json:"volumes"`
		} `json:"services"`
	}
	if err := json.Unmarshal(output, &compose); err != nil {
		return nil, fmt.Errorf("decode Compose configuration: %w", err)
	}
	for name, service := range compose.Services {
		if service.Privileged || service.Pid == "host" || service.NetworkMode == "host" {
			return nil, fmt.Errorf("Compose service %q requests a forbidden host boundary", name)
		}
		if name == primaryService {
			dropped := make(map[string]bool, len(service.CapDrop))
			for _, capability := range service.CapDrop {
				dropped[strings.TrimPrefix(strings.ToUpper(capability), "CAP_")] = true
			}
			if !dropped["ALL"] && (!dropped["NET_RAW"] || !dropped["SYS_PTRACE"]) {
				return nil, errors.New("primary Dev Container must drop NET_RAW and SYS_PTRACE")
			}
		}
		for _, mount := range service.Volumes {
			if mount.Target == "/var/run/docker.sock" || mount.Target == "/factory/assignment" {
				return nil, fmt.Errorf("Compose service %q mounts a forbidden infrastructure path", name)
			}
			if mount.Type == "bind" && !pathWithin(assignment.WorkspaceFolder, mount.Source) {
				return nil, fmt.Errorf("Compose service %q bind mount leaves the assigned checkout", name)
			}
		}
	}
	if _, exists := compose.Services[primaryService]; !exists {
		return nil, errors.New("primary Dev Container service is not declared")
	}
	selected := make(map[string]bool)
	var selectService func(string) error
	selectService = func(name string) error {
		if selected[name] {
			return nil
		}
		service, exists := compose.Services[name]
		if !exists {
			return errors.New("Dev Container start references an undeclared Compose service")
		}
		selected[name] = true
		for dependency := range service.DependsOn {
			if err := selectService(dependency); err != nil {
				return err
			}
		}
		return nil
	}
	if len(runServices) == 0 {
		for name, service := range compose.Services {
			if len(service.Profiles) == 0 {
				runServices = append(runServices, name)
			}
		}
	}
	for _, name := range append(runServices, primaryService) {
		if err := selectService(name); err != nil {
			return nil, err
		}
	}
	var images []string
	for name := range selected {
		service := compose.Services[name]
		// A build service's image may name its local output. The exact CLI still
		// owns Dockerfile/Feature builds; only registry inputs are acquired here.
		if service.Image != "" && (len(service.Build) == 0 || string(service.Build) == "null") {
			images = append(images, service.Image)
		}
	}
	return images, nil
}

func pathWithin(root string, candidate string) bool {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedCandidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func cleanupAttempt(assignment Assignment) error {
	output, err := exec.Command(
		"docker", "ps", "-aq",
		"--filter", "label="+attemptLabel+"="+assignment.RuntimeAttemptID,
		"--filter", "label="+generationLabel+"="+strconv.FormatUint(assignment.Generation, 10),
	).Output()
	if err != nil {
		return fmt.Errorf("find failed runtime containers: %w", err)
	}
	projects := map[string]struct{}{assignment.ComposeProjectName: {}}
	for _, containerID := range strings.Fields(string(output)) {
		container, inspectErr := inspectContainer(containerID)
		if inspectErr != nil {
			return inspectErr
		}
		project := container.Config.Labels["com.docker.compose.project"]
		if project != "" {
			projects[project] = struct{}{}
		}
	}
	for project := range projects {
		if err := cleanupProject(parentState{ComposeProjectName: project, PreserveWorkspace: assignment.PreserveWorkspace}); err != nil {
			return err
		}
	}
	return nil
}

func checkoutProject(ctx context.Context, assignment Assignment) error {
	if _, err := os.Stat(assignment.WorkspaceFolder); err == nil {
		if _, gitErr := os.Stat(filepath.Join(assignment.WorkspaceFolder, ".git")); gitErr != nil {
			return errors.New("workspace folder exists but is not the assigned Git checkout")
		}
		repositoryIdentity, identityErr := exec.CommandContext(
			ctx,
			"git", "-c", "safe.directory="+assignment.WorkspaceFolder, "-C", assignment.WorkspaceFolder,
			"config", "--get", "factory.repositoryIdentity",
		).Output()
		if identityErr != nil || strings.TrimSpace(string(repositoryIdentity)) != assignment.RepositoryIdentity {
			return errors.New("workspace folder exists but its repository identity does not match the assignment")
		}
		if originErr := exec.CommandContext(
			ctx,
			"git", "-c", "safe.directory="+assignment.WorkspaceFolder, "-C", assignment.WorkspaceFolder,
			"remote", "set-url", "origin", assignment.RepositoryURL,
		).Run(); originErr != nil {
			return errors.New("Workspace Git origin could not be refreshed")
		}
		if assignment.PreserveWorkspace {
			return nil
		}
		head, headErr := exec.CommandContext(
			ctx, "git", "-c", "safe.directory="+assignment.WorkspaceFolder,
			"-C", assignment.WorkspaceFolder, "rev-parse", "HEAD",
		).Output()
		if headErr != nil || strings.TrimSpace(string(head)) != assignment.Revision {
			return errors.New("workspace folder does not contain the assigned revision")
		}
		status, statusErr := exec.CommandContext(
			ctx, "git", "-c", "safe.directory="+assignment.WorkspaceFolder,
			"-C", assignment.WorkspaceFolder, "status", "--porcelain",
		).Output()
		if statusErr != nil || len(bytes.TrimSpace(status)) != 0 {
			return errors.New("workspace folder is not a clean checkout")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect workspace folder: %w", err)
	}
	if assignment.PreserveWorkspace {
		return errors.New("canonical Workspace source is not initialized")
	}
	if err := os.MkdirAll(filepath.Dir(assignment.WorkspaceFolder), 0755); err != nil {
		return fmt.Errorf("create workspace parent: %w", err)
	}
	command := exec.CommandContext(ctx, "git", "clone", "--no-checkout", "--", assignment.RepositoryURL, assignment.WorkspaceFolder)
	if err := command.Run(); err != nil {
		return errors.New("Project repository checkout failed; check repository access and connectivity")
	}
	if err := exec.CommandContext(ctx, "git", "-C", assignment.WorkspaceFolder, "checkout", "--detach", assignment.Revision).Run(); err != nil {
		return errors.New("Assigned Project revision could not be checked out")
	}
	if output, err := exec.CommandContext(
		ctx,
		"git", "-C", assignment.WorkspaceFolder, "config", "factory.repositoryIdentity", assignment.RepositoryIdentity,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("record workspace repository identity: %w: %s", err, output)
	}
	if output, err := exec.CommandContext(ctx, "chown", "-R", "1000:1000", assignment.WorkspaceFolder).CombinedOutput(); err != nil {
		return fmt.Errorf("assign Project checkout ownership: %w: %s", err, output)
	}
	return nil
}

func waitForDocker(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for attempt := 0; attempt < 120; attempt++ {
		command := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}")
		if err := command.Run(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return errors.New("private Docker daemon did not become ready")
}

// Cache only the assigned immutable image before starting the child. A cold
// registry download must not consume a browser session's short execution lease.
func ensureBrowserImage(parent context.Context, reference string) error {
	if reference == "" {
		return nil
	}
	if !browserImagePattern.MatchString(reference) {
		return errors.New("browser tools image must be pinned by exact digest")
	}
	ctx, end := context.WithTimeout(parent, 180*time.Second)
	defer end()
	confirmed := func() bool {
		if strings.HasPrefix(reference, "sha256:") {
			output, err := browserDocker(ctx, "image", "inspect", "--format", "{{.Id}}", reference)
			return err == nil && strings.TrimSpace(string(output)) == reference
		}
		output, err := browserDocker(ctx, "image", "inspect", "--format", "{{json .RepoDigests}}", reference)
		var digests []string
		if err != nil || json.Unmarshal(output, &digests) != nil {
			return false
		}
		for _, digest := range digests {
			if digest == reference {
				return true
			}
		}
		return false
	}
	if confirmed() {
		return nil
	}
	if ctx.Err() != nil {
		return errors.New("browser tools image startup was cancelled or exceeded 180 seconds")
	}
	retryDelay := 250 * time.Millisecond
	for {
		command := exec.CommandContext(ctx, "docker", "pull", reference)
		var diagnostic browserDockerOutput
		// Keep only bounded, ephemeral diagnostics for failure classification.
		// No Registry text, progress or credentials reach the model or Evidence.
		command.Stderr = &diagnostic
		if command.Run() == nil {
			if !confirmed() {
				return errors.New("browser tools image exact digest was not confirmed after download")
			}
			return nil
		}
		if ctx.Err() != nil {
			return errors.New("browser tools image startup was cancelled or exceeded 180 seconds")
		}
		if !retryableBrowserImageDownload(string(diagnostic.Bytes())) {
			return errors.New("browser tools image download failed; check registry connectivity and approved CA trust")
		}
		// An immutable image acquisition can safely recover before any browser
		// exists. Keep the original startup deadline and one worker; never
		// repeat an App call or model request.
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errors.New("browser tools image startup was cancelled or exceeded 180 seconds")
		case <-timer.C:
		}
		if confirmed() {
			return nil
		}
		retryDelay = min(retryDelay*2, 2*time.Second)
	}
}

func retryableBrowserImageDownload(diagnostic string) bool {
	value := strings.ToLower(diagnostic)
	for _, permanent := range []string{"x509:", "unauthorized", "forbidden", "denied:", "manifest unknown", "invalid reference"} {
		if strings.Contains(value, permanent) {
			return false
		}
	}
	for _, transient := range []string{
		"connection refused", "connection reset", "no route to host", "no such host",
		"i/o timeout", "tls handshake timeout", "context deadline exceeded", "unexpected eof",
		"temporary failure in name resolution", "server misbehaving",
		"500 internal server error", "502 bad gateway", "503 service unavailable", "504 gateway timeout",
	} {
		if strings.Contains(value, transient) {
			return true
		}
	}
	return false
}

// Compose lookup in the pinned CLI uses project/service, not --id-label. A prior
// interrupted Stop can therefore return an old primary. Remove only a proven
// older primary before up; never rebind it or force-recreate this attempt.
func removePreviousPrimary(ctx context.Context, assignment Assignment) error {
	output, err := exec.CommandContext(ctx, "docker", "ps", "-aq", "--no-trunc",
		"--filter", "label=com.docker.compose.project="+assignment.ComposeProjectName,
		"--filter", "label="+attemptLabel,
	).Output()
	if err != nil {
		return errors.New("could not inspect retained Dev Container identity")
	}
	var previous []string
	current := false
	for _, id := range strings.Fields(string(output)) {
		container, err := inspectContainer(id)
		if err != nil {
			return err
		}
		labels := container.Config.Labels
		generation, err := strconv.ParseUint(labels[generationLabel], 10, 64)
		if container.ID != id || labels["com.docker.compose.project"] != assignment.ComposeProjectName || err != nil || generation == 0 || labels[attemptLabel] == "" {
			return errors.New("retained Dev Container identity could not be confirmed")
		}
		if generation == assignment.Generation && labels[attemptLabel] == assignment.RuntimeAttemptID {
			current = true
			continue
		}
		if generation >= assignment.Generation || labels[attemptLabel] == assignment.RuntimeAttemptID {
			return errors.New("retained Dev Container belongs to a conflicting runtime generation")
		}
		previous = append(previous, id)
	}
	if current && len(previous) != 0 {
		return errors.New("retained Dev Container has conflicting primary identities")
	}
	if len(previous) == 0 {
		return nil
	}
	if err := exec.CommandContext(ctx, "docker", append([]string{"rm", "-f"}, previous...)...).Run(); err != nil {
		return errors.New("could not remove the previous Dev Container; retry Workspace start")
	}
	return nil
}

func startDevcontainer(ctx context.Context, assignment Assignment) (devcontainerResult, error) {
	if err := removePreviousPrimary(ctx, assignment); err != nil {
		return devcontainerResult{}, fmt.Errorf("%w: %w", errDevcontainerNotStarted, err)
	}
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	arguments := []string{
		"up",
		"--workspace-folder", assignment.WorkspaceFolder,
		"--config", configPath,
		"--log-format", "json",
		"--update-remote-user-uid-default", "never",
		"--id-label", attemptLabel + "=" + assignment.RuntimeAttemptID,
		"--id-label", generationLabel + "=" + strconv.FormatUint(assignment.Generation, 10),
	}
	if assignment.EffectiveConfiguration != "" {
		arguments = append(arguments, "--override-config", assignment.EffectiveConfiguration)
	}
	if assignment.EnvironmentSecretsFile != "" {
		arguments = append(arguments, "--secrets-file", assignment.EnvironmentSecretsFile, "--oci-auth-hardening")
	}
	if assignment.PrebuildCacheImage != "" {
		arguments = append(arguments, "--cache-from", assignment.PrebuildCacheImage)
	}
	command := exec.CommandContext(ctx, "devcontainer", arguments...)
	command.Env = devcontainerEnvironment(assignment)
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		for _, line := range strings.Split(stdout.String(), "\n") {
			var failure struct {
				Outcome     string `json:"outcome"`
				Description string `json:"description"`
			}
			if json.Unmarshal([]byte(line), &failure) == nil && failure.Outcome == "error" {
				for _, hook := range []string{"onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"} {
					if strings.Contains(failure.Description, hook) {
						return devcontainerResult{}, fmt.Errorf("Dev Container %s failed; check the repository hook and its environment grants", hook)
					}
				}
			}
		}
		return devcontainerResult{}, fmt.Errorf("start Dev Container: %w", err)
	}
	var result devcontainerResult
	for _, line := range strings.Split(stdout.String(), "\n") {
		var candidate devcontainerResult
		if json.Unmarshal([]byte(line), &candidate) == nil && candidate.Outcome != "" {
			result = candidate
		}
	}
	if result.Outcome != "success" || len(result.ContainerID) != 64 || result.RemoteUser == "" {
		return devcontainerResult{}, errors.New("Dev Containers CLI returned an incomplete result")
	}
	if result.ComposeProjectName != "" && result.ComposeProjectName != assignment.ComposeProjectName {
		return devcontainerResult{}, errors.New("Dev Containers CLI returned an unexpected Compose project identity")
	}
	if result.RemoteWorkspaceFolder != assignment.RemoteWorkspaceFolder {
		return devcontainerResult{}, errors.New("Dev Containers CLI returned an unexpected remote workspace")
	}
	container, err := inspectContainer(result.ContainerID)
	if err != nil {
		return devcontainerResult{}, err
	}
	if !container.State.Running {
		return devcontainerResult{}, errors.New("primary Dev Container exited during startup")
	}
	if container.Config.Labels[attemptLabel] != assignment.RuntimeAttemptID || container.Config.Labels[generationLabel] != strconv.FormatUint(assignment.Generation, 10) {
		return devcontainerResult{}, errors.New("primary container did not retain its runtime identity")
	}
	if result.ComposeProjectName != "" && container.Config.Labels["com.docker.compose.project"] != result.ComposeProjectName {
		return devcontainerResult{}, errors.New("primary container Compose identity does not match the CLI result")
	}
	if err := validateContainerBoundary(container, assignment); err != nil {
		return devcontainerResult{}, err
	}
	// Factory ownership still comes from exact attempt/generation labels. The
	// standalone CLI path has no Compose project label and needs exact cleanup.
	if result.ComposeProjectName == "" {
		result.ComposeProjectName = assignment.ComposeProjectName
	}
	return result, nil
}

func injectChild(ctx context.Context, assignment Assignment, result devcontainerResult, token string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Connector executable: %w", err)
	}
	connectorPath := fmt.Sprintf("/tmp/factory-runtime-connector-%d", assignment.Generation)
	assignmentPath := fmt.Sprintf("/tmp/factory-runtime-assignment-%d.json", assignment.Generation)
	childAssignment := assignment
	childAssignment.WorkspaceFolder = result.RemoteWorkspaceFolder
	encoded, err := json.Marshal(childAssignment)
	if err != nil {
		return fmt.Errorf("encode child assignment: %w", err)
	}
	temporary, err := os.CreateTemp("", "factory-runtime-assignment-*.json")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	for _, copy := range [][2]string{{executable, connectorPath}, {temporaryName, assignmentPath}} {
		if output, err := exec.CommandContext(ctx, "docker", "cp", copy[0], result.ContainerID+":"+copy[1]).CombinedOutput(); err != nil {
			return fmt.Errorf("copy Connector child artifact: %w: %s", err, output)
		}
	}
	if err := injectApprovedTools(ctx, assignment, result.ContainerID); err != nil {
		return err
	}
	setup := exec.CommandContext(
		ctx,
		"docker", "exec", result.ContainerID, "sh", "-c",
		"chmod 0555 \"$1\" && chmod 0444 \"$2\"",
		"factory-connector-setup", connectorPath, assignmentPath,
	)
	if output, err := setup.CombinedOutput(); err != nil {
		return fmt.Errorf("prepare Connector child: %w: %s", err, output)
	}
	command := exec.CommandContext(
		ctx,
		"docker", "exec", "--interactive", "--user", result.RemoteUser,
		result.ContainerID, connectorPath, "child", "--assignment", assignmentPath, "--token-stdin",
	)
	credentials, _ := json.Marshal(map[string]any{"token": token, "environment": assignment.RuntimeEnvironment})
	command.Stdin = strings.NewReader(string(credentials))
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start Connector child: %w", err)
	}
	go command.Wait()
	return nil
}

func injectApprovedTools(ctx context.Context, assignment Assignment, containerID string) error {
	needsAgent := false
	needsVerification := false
	needsLanguages := false
	for _, channel := range assignment.Channels {
		if channel.Kind == "agent" {
			needsAgent = true
		}
		if channel.Kind == "verification" {
			needsVerification = true
		}
		if channel.Kind == "ide" {
			needsLanguages = true
		}
	}
	if !needsAgent && !needsVerification && !needsLanguages {
		return nil
	}
	if needsLanguages {
		tool := "/opt/factory/language-tools/musl"
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "sh", "-c", "ldd --version 2>&1").CombinedOutput(); !strings.Contains(strings.ToLower(string(output)), "musl") {
			if err != nil {
				return errors.New("Language tools require a supported glibc or musl development container")
			}
			tool = "/opt/factory/language-tools/glibc"
		}
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "mkdir", "-p", "/opt/factory/language-tools/runtime").CombinedOutput(); err != nil {
			return fmt.Errorf("create language tools destination: %w: %s", err, output)
		}
		for _, copy := range [][2]string{{"/opt/factory/language-tools/node_modules", "/opt/factory/language-tools/node_modules"}, {tool + "/.", "/opt/factory/language-tools/runtime"}} {
			if output, err := exec.CommandContext(ctx, "docker", "cp", copy[0], containerID+":"+copy[1]).CombinedOutput(); err != nil {
				return fmt.Errorf("inject language tools: %w: %s", err, output)
			}
		}
	}
	if needsAgent {
		// Match the primary container's native libc. Upstream binaries stay
		// unmodified; no injected loader or compatibility package is required.
		tool := "/opt/factory/opencode/musl/bun"
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "sh", "-c", "ldd --version 2>&1").CombinedOutput(); !strings.Contains(strings.ToLower(string(output)), "musl") {
			if err != nil {
				return errors.New("OpenCode requires a supported glibc or musl development container")
			}
			tool = "/opt/factory/opencode/glibc/bun"
		}
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "mkdir", "-p", "/opt/factory/opencode").CombinedOutput(); err != nil {
			return fmt.Errorf("create OpenCode destination: %w: %s", err, output)
		}
		if output, err := exec.CommandContext(ctx, "docker", "cp", "/opt/factory/opencode/server", containerID+":/opt/factory/opencode/server").CombinedOutput(); err != nil {
			return fmt.Errorf("inject native OpenCode server: %w: %s", err, output)
		}
		if output, err := exec.CommandContext(ctx, "docker", "cp", tool, containerID+":/opt/factory/opencode/bun").CombinedOutput(); err != nil {
			return fmt.Errorf("inject OpenCode: %w: %s", err, output)
		}
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "chmod", "0555", "/opt/factory/opencode/bun").CombinedOutput(); err != nil {
			return fmt.Errorf("prepare OpenCode: %w: %s", err, output)
		}
	}
	if needsVerification {
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "mkdir", "-p", "/opt/factory").CombinedOutput(); err != nil {
			return fmt.Errorf("create Forgejo Runner destination: %w: %s", err, output)
		}
		if output, err := exec.CommandContext(ctx, "docker", "cp", "/usr/local/bin/forgejo-runner", containerID+":/opt/factory/forgejo-runner").CombinedOutput(); err != nil {
			return fmt.Errorf("inject Forgejo Runner: %w: %s", err, output)
		}
		if output, err := exec.CommandContext(ctx, "docker", "exec", containerID, "chmod", "0555", "/opt/factory/forgejo-runner").CombinedOutput(); err != nil {
			return fmt.Errorf("prepare Forgejo Runner: %w: %s", err, output)
		}
	}
	return nil
}

func inspectContainer(containerID string) (inspectedContainer, error) {
	output, err := exec.Command("docker", "inspect", containerID).Output()
	if err != nil {
		return inspectedContainer{}, fmt.Errorf("inspect primary container: %w", err)
	}
	var containers []inspectedContainer
	if err := json.Unmarshal(output, &containers); err != nil || len(containers) != 1 {
		return inspectedContainer{}, errors.New("decode primary container inspection")
	}
	return containers[0], nil
}

func cleanupProject(state parentState) error {
	if state.ContainerID != "" {
		container, err := inspectContainer(state.ContainerID)
		if err == nil && container.Config.Labels["com.docker.compose.project"] == "" {
			if container.ID != state.ContainerID || container.Config.Labels[attemptLabel] != state.RuntimeAttemptID || container.Config.Labels[generationLabel] != strconv.FormatUint(state.Generation, 10) {
				return errors.New("Standalone cleanup identity changed")
			}
			if exec.Command("docker", "rm", "-f", state.ContainerID).Run() != nil {
				return errors.New("standalone runtime cleanup failed")
			}
		}
	}
	label := "com.docker.compose.project=" + state.ComposeProjectName
	for _, resource := range []struct {
		list   []string
		remove []string
	}{
		{[]string{"ps", "-aq", "--filter", "label=" + label}, []string{"rm", "-f"}},
		{[]string{"network", "ls", "-q", "--filter", "label=" + label}, []string{"network", "rm"}},
		{[]string{"volume", "ls", "-q", "--filter", "label=" + label}, []string{"volume", "rm", "-f"}},
	} {
		// Development data belongs to the durable Workspace, not its disposable compute.
		if state.PreserveWorkspace && resource.list[0] == "volume" {
			continue
		}
		output, err := exec.Command("docker", resource.list...).Output()
		if err != nil {
			return fmt.Errorf("list inner runtime resources: %w", err)
		}
		ids := strings.Fields(string(output))
		if len(ids) == 0 {
			continue
		}
		arguments := append(append([]string{}, resource.remove...), ids...)
		if output, err := exec.Command("docker", arguments...).CombinedOutput(); err != nil {
			return fmt.Errorf("remove inner runtime resources: %w: %s", err, output)
		}
	}
	return nil
}

func writeParentState(assignment Assignment, state parentState) error {
	directory := assignment.ConnectorStateDir
	if directory == "" {
		directory = "/var/lib/factory/runtime-connector"
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return fmt.Errorf("create Connector state directory: %w", err)
	}
	content, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".state-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	path := filepath.Join(directory, assignment.RuntimeAttemptID+"-"+strconv.FormatUint(assignment.Generation, 10)+".json")
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("persist Connector state: %w", err)
	}
	return nil
}
