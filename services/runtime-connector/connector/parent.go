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

var errBrowserImageStartup = fmt.Errorf("browser tools image startup was cancelled or exceeded %d seconds", int(browserImagePullTimeout/time.Second))

type devcontainerResult struct {
	Outcome               string `json:"outcome"`
	ContainerID           string `json:"containerId"`
	ComposeProjectName    string `json:"composeProjectName"`
	RemoteUser            string `json:"remoteUser"`
	RemoteWorkspaceFolder string `json:"remoteWorkspaceFolder"`
}

type parentState struct {
	RuntimeAttemptID   string           `json:"runtimeAttemptId"`
	Generation         uint64           `json:"generation"`
	ContainerID        string           `json:"containerId"`
	ComposeProjectName string           `json:"composeProjectName"`
	PreserveWorkspace  bool             `json:"preserveWorkspace"`
	ContainerOrigin    *containerOrigin `json:"containerOrigin,omitempty"`
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
	return runParent(ctx, assignment, token, childToken, nil)
}

func runParent(ctx context.Context, assignment Assignment, token string, childToken string, prepared *preparedProject) (returnError error) {
	environment, err := readRuntimeEnvironment(ctx, assignment, token)
	if err != nil {
		return err
	}
	assignment.PublicImageBuild = publicImageBuild(environment)
	assignment.BuildEnvironmentSHA256 = imageBuildEnvironmentSHA256(environment)
	ctx, releaseEnvironment, err := applyRuntimeEnvironment(ctx, &assignment, environment)
	defer releaseEnvironment()
	if err != nil {
		return err
	}
	if token == "" || childToken == "" {
		return errors.New("Factory parent and child connector tokens are required")
	}
	prepared, preparedDependencies, err := reconcilePreparedProject(assignment, environment, prepared)
	if err != nil {
		return err
	}
	if prepared != nil {
		origin := prepared.origin
		assignment.containerOrigin = &origin
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
	if err != nil && os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID") == "" {
		return err
	}
	var initialBackoff reconnectBackoff
	for err != nil {
		// Like Child, Parent may start before Factory has observed a native
		// allocation. Reconnect transport only; no checkout/hook was started.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(initialBackoff.next()):
		}
		control, err = dialControl(ctx, assignment, "parent", token)
	}
	defer func() { control.close() }()
	if err := control.write(Message{
		Type:       "hello",
		Role:       "parent",
		AttemptID:  assignment.RuntimeAttemptID,
		Generation: assignment.Generation,
		Channels:   parentChannels(assignment),
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
		return retainParentStartupFailure(ctx, assignment, token, &control, err)
	}
	if assignment.Prebuild != nil {
		return runPrebuildAttempt(ctx, assignment, token, control)
	}
	if prepared == nil {
		cleanup, err := prepareFreshDevcontainer(ctx, &assignment, token, preparedDependencies)
		defer cleanup()
		if err != nil {
			return retainParentStartupFailure(ctx, assignment, token, &control, err)
		}
	}
	preparation := prepareBrowserImage(ctx, func(ctx context.Context) error {
		return ensureBrowserImage(ctx, assignment.BrowserToolsImage)
	})
	defer preparation.stop()
	finishDevcontainer := startupPhase("devcontainer-start")
	var result devcontainerResult
	if prepared == nil {
		result, err = startDevcontainer(ctx, assignment)
	} else {
		result, err = prepared.observe()
	}
	finishDevcontainer()
	if err != nil {
		err = cleanupFailedParentStartup(assignment, err)
		return retainParentStartupFailure(ctx, assignment, token, &control, err)
	}
	if prepared == nil {
		// The CLI's standalone image path has no Compose label. Preserve that
		// observed absence instead of substituting the logical Workspace name.
		// Browser and cleanup still require this exact primary/attempt/generation.
		origin := containerOrigin{assignment.RuntimeAttemptID, assignment.Generation, result.ComposeProjectName}
		assignment.containerOrigin = &origin
	}
	state := parentState{
		RuntimeAttemptID:   assignment.RuntimeAttemptID,
		Generation:         assignment.Generation,
		ContainerID:        result.ContainerID,
		ComposeProjectName: result.ComposeProjectName,
		PreserveWorkspace:  assignment.PreserveWorkspace,
		ContainerOrigin:    assignment.containerOrigin,
	}
	retainingFailure := false
	defer func() {
		if retainingFailure && keepsParentStartupSource(assignment) {
			return
		}
		if err := cleanupProject(state); err != nil && returnError == nil {
			returnError = err
			control.write(Message{Type: "status", Phase: "cleanup-failed", Error: err.Error()})
			return
		}
		_ = trimPrivateBuildCache(ctx)
		control.write(Message{Type: "status", Phase: "stopped"})
	}()
	if err := writeParentState(assignment, state); err != nil {
		retainingFailure = true
		return retainParentStartupFailure(ctx, assignment, token, &control, err)
	}
	browser := newBrowserRuntimeManager(ctx, assignment, result.ContainerID, result.RemoteUser)
	browser.preparation = preparation
	defer func() {
		if err := browser.closeAll(); err != nil {
			control.write(Message{Type: "status", Phase: "cleanup-failed", Error: err.Error()})
			returnError = errors.Join(returnError, err)
		}
	}()
	finishInjection := startupPhase("tool-injection")
	var injectionErr error
	if prepared == nil {
		injectionErr = injectChild(ctx, assignment, result, childToken)
	} else {
		injectionErr = activatePreparedChild(ctx, assignment, result, childToken)
	}
	finishInjection()
	if err := injectionErr; err != nil {
		retainingFailure = true
		return retainParentStartupFailure(ctx, assignment, token, &control, err)
	}
	if err := announceChildStarted(ctx, assignment, token, &control); err != nil {
		return err
	}
	return serveParentControl(ctx, assignment, token, &control, browser, func(operationContext context.Context, message Message) Message {
		return handleParentOperation(operationContext, assignment, message)
	})
}

// applyRuntimeEnvironment materializes the Runtime environment bundle for this
// attempt. The returned release function is always safe to call.
func applyRuntimeEnvironment(ctx context.Context, assignment *Assignment, environment runtimeEnvironment) (context.Context, func(), error) {
	if assignment.EnvironmentVersion == nil {
		return ctx, func() {}, nil
	}
	files, err := prepareEnvironmentFiles(environment)
	if err != nil {
		return ctx, func() {}, errors.New("Runtime environment preparation failed")
	}
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
			directory, err := registryCertificateDirectory(*assignment, registry.Host)
			if err != nil {
				return ctx, files.cleanup, err
			}
			if err := os.MkdirAll(directory, 0700); err != nil {
				return ctx, files.cleanup, errors.New("Registry trust preparation failed")
			}
			if err := os.WriteFile(filepath.Join(directory, "ca.crt"), []byte(registry.Certificate), 0600); err != nil {
				return ctx, files.cleanup, errors.New("Registry trust preparation failed")
			}
		}
	}
	return ctx, files.cleanup, nil
}

// reconcilePreparedProject decides whether a captured prepared Project can serve
// this assignment. It returns the prepared Project to keep, if any, and the
// prepared Project whose dependency files may seed a fresh start.
func reconcilePreparedProject(assignment Assignment, environment runtimeEnvironment, prepared *preparedProject) (*preparedProject, *preparedProject, error) {
	if prepared == nil {
		return nil, nil, nil
	}
	// Runtime grants are read only after assignment. Never inject them into
	// the captured clean processes, even when only their version changed.
	if samePreparedProject(prepared.assignment, assignment) &&
		len(environment.Bundle.Variables) == 0 && len(environment.Bundle.Registries) == 0 {
		return prepared, nil, nil
	}
	if err := cleanupProject(prepared.state()); err != nil {
		return nil, nil, err
	}
	// This is the Fork's separate clean checkout, never canonical
	// Workspace source. Fresh grants require fresh processes and
	// hooks, not deletion of its exact prepared dependency files.
	// checkoutProject still verifies its Project, commit and clean
	// tracked source before the ordinary Dev Container startup.
	if reusablePreparedDependencies(prepared.assignment, assignment, environment) {
		return nil, prepared, nil
	}
	if err := os.RemoveAll(assignment.WorkspaceFolder); err != nil {
		return nil, nil, err
	}
	return nil, nil, nil
}

// runPrebuildAttempt produces and publishes a Project prebuild instead of
// starting a Dev Container.
func runPrebuildAttempt(ctx context.Context, assignment Assignment, token string, control *controlConnection) error {
	bounded, cancel := context.WithTimeout(ctx, prebuildTimeout)
	defer cancel()
	return servePrebuildControl(bounded, assignment, token, control, func(ctx context.Context) error {
		platform, err := runtimePrebuildPlatform(ctx)
		if err != nil {
			return err
		}
		result, err := ProducePrebuild(ctx, assignment, PrebuildRequest{Commit: assignment.Revision, Platform: platform, ImageRepository: assignment.Prebuild.ImageRepository})
		if err != nil {
			return err
		}
		return publishRuntimePrebuild(ctx, assignment, token, result)
	})
}

// prepareFreshDevcontainer selects a prebuilt image when one is compatible and
// validates the Dev Container configuration before the CLI can run any
// lifecycle hook. The returned cleanup is always safe to call.
func prepareFreshDevcontainer(ctx context.Context, assignment *Assignment, token string, preparedDependencies *preparedProject) (func(), error) {
	var cleanups []func()
	cleanup := func() {
		for index := len(cleanups) - 1; index >= 0; index-- {
			cleanups[index]()
		}
	}
	if preparedDependencies != nil && preparedDependencies.rootFSImage != "" {
		image, err := preparedDependencies.inspectRootFS(ctx, preparedDependencies.rootFSImage)
		if err != nil {
			return cleanup, err
		}
		consumer := *assignment
		consumer.preparedRootFSImage = image
		path, remove, err := preparePrebuildConsumer(ctx, consumer, image)
		if err == nil {
			cleanups = append(cleanups, remove)
			assignment.EffectiveConfiguration = path
			assignment.preparedRootFSImage = image
		}
	}
	if assignment.EffectiveConfiguration == "" {
		assignment.PrebuildCacheImage = compatibleRuntimePrebuild(ctx, *assignment, token)
		if assignment.PrebuildCacheImage != "" {
			path, remove, err := preparePrebuildConsumer(ctx, *assignment, assignment.PrebuildCacheImage)
			if err == nil {
				cleanups = append(cleanups, remove)
				assignment.EffectiveConfiguration = path
			}
		}
	}
	if err := prepareDevcontainerProject(ctx, *assignment); err != nil {
		return cleanup, err
	}
	if assignment.nativeActorUID != "" && assignment.EffectiveConfiguration == "" {
		path, image, remove, err := prepareNativeDependencies(ctx, assignment)
		cleanups = append(cleanups, remove)
		if err != nil {
			return cleanup, err
		}
		if path != "" {
			assignment.EffectiveConfiguration = path
			assignment.preparedRootFSImage = image
			// Validate the generated overlay with the same boundary checks. Source
			// still declares the original image, Features, hooks and Compose data.
			return cleanup, prepareDevcontainerProject(ctx, *assignment)
		}
	}
	return cleanup, nil
}

// serveParentControl reads Factory control messages until Stop or cancellation.
// Git operations run on a single worker so a slow operation cannot hide a Stop
// message from this read loop.
func serveParentControl(
	ctx context.Context,
	assignment Assignment,
	token string,
	control **controlConnection,
	browser *browserRuntimeManager,
	handle func(context.Context, Message) Message,
) error {
	browserHandle := browser.handle
	if assignment.nativeSource != nil {
		fence := &parentSourceFence{}
		handle = fence.wrap(handle)
		browserHandle = fence.wrap(browserHandle)
	}
	operations := startParentOperations(ctx, handle)
	defer operations.stop()
	connectionContext, disconnect := browserConnectionContext(ctx)
	defer func() { disconnect() }()
	sourceStreams := &parentSourceStreams{handler: assignment.nativeSource}
	for {
		var message Message
		if err := (*control).read(&message); err != nil {
			disconnect()
			if err := browser.closeAll(); err != nil {
				return err
			}
			if ctx.Err() != nil {
				return nil
			}
			(*control).close()
			if err := announceChildStarted(ctx, assignment, token, control); err != nil {
				return nil
			}
			connectionContext, disconnect = browserConnectionContext(ctx)
			continue
		}
		if message.Type == "stop" {
			(*control).write(Message{Type: "status", Phase: "stopping"})
			return nil
		}
		if message.Type == "http-request" {
			sourceStreams.start(connectionContext, *control, message)
			continue
		}
		if message.Type == "stream-close" {
			sourceStreams.close(message.StreamID)
			continue
		}
		if message.Type == "operation-request" {
			if strings.HasPrefix(message.Action, "browser-") {
				go handleBrowserControlOperation(connectionContext, disconnect, *control, browserHandle, message)
				continue
			}
			if !operations.submit(*control, message) {
				response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "parent operation queue is full"}
				if err := (*control).write(response); err != nil {
					(*control).close()
				}
			}
		}
	}
}

// parentOperations runs non-browser Parent operations one at a time, in order,
// off the control read loop. Cancelling its context kills an in-flight Git run.
type parentOperations struct {
	queue  chan parentOperation
	cancel context.CancelFunc
	done   chan struct{}
}

type parentOperation struct {
	control *controlConnection
	message Message
}

func startParentOperations(ctx context.Context, handle func(context.Context, Message) Message) *parentOperations {
	ctx, cancel := context.WithCancel(ctx)
	operations := &parentOperations{
		queue:  make(chan parentOperation, parentOperationQueueLimit),
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(operations.done)
		for {
			select {
			case <-ctx.Done():
				return
			case operation := <-operations.queue:
				response := handle(ctx, operation.message)
				if err := operation.control.write(response); err != nil {
					// The operation may have completed. Recover the control connection,
					// never replay the operation or tear down its admitted compute.
					operation.control.close()
				}
			}
		}
	}()
	return operations
}

func (operations *parentOperations) submit(control *controlConnection, message Message) bool {
	select {
	case operations.queue <- parentOperation{control: control, message: message}:
		return true
	default:
		return false
	}
}

func (operations *parentOperations) stop() {
	operations.cancel()
	<-operations.done
}

func handleBrowserControlOperation(ctx context.Context, disconnect context.CancelFunc, control *controlConnection, handle func(context.Context, Message) Message, message Message) {
	if err := control.write(handle(ctx, message)); err != nil {
		// A failed response cannot leave Parent reading another request on a
		// half-open socket while Factory waits for acknowledgements. Close only
		// this captured connection; recovery never replays the operation.
		disconnect()
		_ = control.close()
	}
}

// A long bootstrap can outlive its first socket. Reconnect only to report its
// failure, never to repeat checkout, Features or lifecycle hooks.
func reportParentStartupFailure(ctx context.Context, assignment Assignment, token string, control **controlConnection, failure error) {
	message := Message{Type: "status", Phase: "failed", Error: failure.Error()}
	// An unread startup socket can accept a local write after its peer closed.
	// Use a fresh authenticated transport for the terminal fact, never a new boot.
	(*control).close()
	if ctx.Err() != nil {
		return
	}
	connected, err := dialControl(ctx, assignment, "parent", token)
	if err != nil {
		return
	}
	*control = connected
	if connected.write(Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation, Channels: parentChannels(assignment)}) == nil {
		_ = connected.write(message)
	}
}

func announceChildStarted(ctx context.Context, assignment Assignment, token string, control **controlConnection) error {
	var backoff reconnectBackoff
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
					Channels:   parentChannels(assignment),
				}); err == nil {
					*control = connected
					backoff.reset()
					break
				}
				connected.close()
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff.next()):
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
	case "source-drain":
		if assignment.nativeSource == nil {
			response.Error = "native Source is unavailable"
			break
		}
		// Stop, do not delete, every container in this Actor-private daemon.
		// Parent operations are already serialized with Git; stopped container
		// identities, filesystems, hooks and volumes remain in native ROOTFS.
		output, err := exec.CommandContext(ctx, "docker", "ps", "--quiet", "--no-trunc").Output()
		if err == nil {
			ids := strings.Fields(string(output))
			for _, id := range ids {
				if len(id) != 64 || strings.Trim(id, "0123456789abcdef") != "" {
					err = errors.New("private container identity is invalid")
					break
				}
			}
			if err == nil && len(ids) != 0 {
				err = exec.CommandContext(ctx, "docker", append([]string{"stop", "--time", "10"}, ids...)...).Run()
			}
			if err == nil {
				output, err = exec.CommandContext(ctx, "docker", "ps", "--quiet", "--no-trunc").Output()
				if err == nil && strings.TrimSpace(string(output)) != "" {
					err = errors.New("private container writers remain running")
				}
			}
		}
		if err != nil {
			response.Error = "private Docker Source writers could not be drained"
		}
	case "workspace-git":
		result, err := personalGit(ctx, assignment, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.Data = result
		}
	case "skills-install":
		response.Error = errorText(installAdmittedSkills(ctx, assignment, message.Data))
	case "git-prepare-commit", "git-observe-commit", "git-prepare-integration":
		if assignment.nativeActorUID != "" {
			ctx = context.WithValue(ctx, nativeCommitGitKey{}, true)
		}
		commit, err := prepareCommit(ctx, assignment.WorkspaceFolder, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.CommitSHA = commit
		}
	case "git-push":
		if assignment.nativeActorUID != "" {
			ctx = context.WithValue(ctx, nativeCommitGitKey{}, true)
		}
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
	registryImages, localImage, err := assignment.registryProjectImages(images)
	if err != nil {
		return err
	}
	if assignment.preparedRootFSImage != "" && !localImage {
		return errors.New("Dev Container did not select its prepared primary dependency image")
	}
	finishImages := startupPhase("project-images")
	err = prepareProjectImages(ctx, registryImages)
	finishImages()
	if err != nil {
		return err
	}
	// Confirmed local images supply immutable metadata to the upstream CLI.
	// Re-read mutable inputs after acquisition before permitting any container.
	finishMerged := startupPhase("devcontainer-merged-configuration")
	currentImages, err := validateDevcontainer(ctx, assignment)
	if err == nil {
		var currentRegistryImages []string
		var currentLocalImage bool
		currentRegistryImages, currentLocalImage, err = assignment.registryProjectImages(currentImages)
		if err == nil && localImage != currentLocalImage {
			err = errors.New("Project image inputs changed during preparation; start compute again")
		}
		if err == nil {
			err = requirePreparedProjectImages(registryImages, currentRegistryImages)
		}
	}
	finishMerged()
	return err
}

func validateDevcontainerConfiguration(ctx context.Context, assignment Assignment, merged bool) ([]string, error) {
	if assignment.nativeActorUID != "" {
		if err := reserveNativeDevcontainerLockfile(assignment); err != nil {
			return nil, err
		}
	}
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
	var diagnostic devcontainerFailureOutput
	command.Stderr = &diagnostic
	output, err := command.Output()
	if err != nil {
		if detail := devcontainerFailureDiagnostic(string(output), diagnostic.String(), assignment); detail != "" {
			return nil, fmt.Errorf("read Dev Container configuration: %w: %s", err, detail)
		}
		return nil, fmt.Errorf("read Dev Container configuration: %w", err)
	}
	type settings struct {
		Privileged   bool     `json:"privileged"`
		Mounts       []string `json:"mounts"`
		RunArguments []string `json:"runArgs"`
		CapAdd       []string `json:"capAdd"`
		SecurityOpt  []string `json:"securityOpt"`
		// initializeCommand runs before the container exists, as the Sandbox's own root
		// with the Docker daemon and Runtime credentials in reach.
		InitializeCommand json.RawMessage `json:"initializeCommand"`
	}
	var result struct {
		Configuration struct {
			settings
			Image             string   `json:"image"`
			DockerComposeFile any      `json:"dockerComposeFile"`
			Service           string   `json:"service"`
			RunServices       []string `json:"runServices"`
		} `json:"configuration"`
		Merged settings `json:"mergedConfiguration"`
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
	// This runs before `devcontainer up`, so a forbidden setting from the
	// Project or its Features is refused before any lifecycle hook executes.
	for _, configured := range []settings{result.Configuration.settings, result.Merged} {
		if hasInitializeCommand(configured.InitializeCommand) {
			return nil, errors.New("Dev Container initializeCommand runs outside the container and is not allowed. Move it to postCreateCommand")
		}
		if err := validateDevcontainerSettings(assignment.WorkspaceFolder, configured.Privileged, configured.Mounts, configured.RunArguments, configured.CapAdd, configured.SecurityOpt); err != nil {
			return nil, err
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

// hasInitializeCommand reports whether the configuration sets a command, in any of the string,
// array or object forms the Dev Container specification allows.
func hasInitializeCommand(raw json.RawMessage) bool {
	text := strings.TrimSpace(string(raw))
	switch text {
	case "", "null", `""`, "[]", "{}":
		return false
	}
	return true
}

// validateDevcontainerSettings refuses Dev Container settings that cross the
// assigned boundary. Mounts and run arguments may only bind paths inside the
// assigned checkout.
func validateDevcontainerSettings(workspace string, privileged bool, mounts, runArguments, capAdd, securityOpt []string) error {
	if privileged {
		return errors.New("Dev Container privileged mode is not allowed")
	}
	if len(capAdd) > 0 {
		return errors.New("Dev Container added capabilities are not allowed")
	}
	for _, option := range securityOpt {
		if forbiddenSecurityOption(option) {
			return errors.New("Dev Container security options cannot disable confinement")
		}
	}
	if err := validateRunArguments(workspace, runArguments); err != nil {
		return err
	}
	for _, mount := range mounts {
		if err := validateMountSpec(workspace, mount); err != nil {
			return err
		}
	}
	return nil
}

// validateMountSpec checks one `type=bind,source=...,target=...` style mount.
func validateMountSpec(workspace string, mount string) error {
	if strings.Contains(mount, "/var/run/docker.sock") || strings.Contains(mount, "/factory/assignment") {
		return errors.New("Dev Container cannot mount infrastructure paths")
	}
	if strings.Contains(mount, "type=bind") {
		for _, field := range strings.Split(mount, ",") {
			if strings.HasPrefix(field, "source=") || strings.HasPrefix(field, "src=") {
				source := strings.TrimPrefix(strings.TrimPrefix(field, "source="), "src=")
				if !pathWithin(workspace, source) {
					return errors.New("Dev Container bind mounts must stay within the assigned checkout")
				}
			}
		}
	}
	return nil
}

// validateVolumeSpec checks a `-v source:target[:options]` value. A first field
// that is a path is a host bind; anything else is a named or anonymous volume.
func validateVolumeSpec(workspace string, volume string) error {
	if strings.Contains(volume, "docker.sock") || strings.Contains(volume, "/factory/assignment") {
		return errors.New("Dev Container cannot mount infrastructure paths")
	}
	source, _, hasTarget := strings.Cut(volume, ":")
	if hasTarget && (strings.HasPrefix(source, "/") || strings.HasPrefix(source, ".") || strings.HasPrefix(source, "~")) &&
		!pathWithin(workspace, source) {
		return errors.New("Dev Container bind mounts must stay within the assigned checkout")
	}
	return nil
}

func forbiddenSecurityOption(option string) bool {
	option = strings.ToLower(strings.ReplaceAll(option, ":", "="))
	return strings.Contains(option, "unconfined") || strings.HasPrefix(option, "label=disable")
}

func validateRunArguments(workspace string, arguments []string) error {
	for index, argument := range arguments {
		name, value, hasValue := strings.Cut(argument, "=")
		if len(argument) > 2 && strings.HasPrefix(argument, "-v") && !strings.HasPrefix(argument, "--") {
			// Docker accepts the short volume flag with its value attached.
			name, value, hasValue = "-v", argument[2:], true
			if strings.HasPrefix(value, "=") {
				value = value[1:]
			}
		}
		if !hasValue && index+1 < len(arguments) {
			value = arguments[index+1]
		}
		switch name {
		case "--privileged", "--device", "--device-cgroup-rule", "--volumes-from", "--cap-add",
			"--security-opt", "--userns", "--runtime", "--cgroup-parent", "--env-file", "--label-file", "--cidfile":
			return fmt.Errorf("Dev Container run argument %q is not allowed", name)
		case "-v", "--volume":
			if err := validateVolumeSpec(workspace, value); err != nil {
				return err
			}
		case "--mount":
			if err := validateMountSpec(workspace, value); err != nil {
				return err
			}
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
	_, cgroupNamespaceError := os.Stat("/proc/self/ns/cgroup")
	forbiddenCgroups := host.CgroupnsMode == "host" && !nativeActorCgroups(assignment, os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID"), cgroupNamespaceError)
	if host.Privileged || host.PidMode != "" || host.IpcMode == "host" || strings.HasPrefix(host.IpcMode, "container:") || host.NetworkMode == "host" || strings.HasPrefix(host.NetworkMode, "container:") || host.UTSMode == "host" || forbiddenCgroups || len(host.CapAdd) > 0 || len(host.Devices) > 0 || len(host.VolumesFrom) > 0 {
		return errors.New("resolved Dev Container crosses a forbidden host boundary")
	}
	for _, option := range host.SecurityOpt {
		if forbiddenSecurityOption(option) {
			return errors.New("resolved Dev Container disables a confinement profile")
		}
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

type composeFileResource struct {
	File string `json:"file"`
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
		if !filepath.IsAbs(file) {
			file = filepath.Join(filepath.Dir(configPath), file)
		}
		arguments = append(arguments, "--file", file)
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
			Ipc         string                     `json:"ipc"`
			Uts         string                     `json:"uts"`
			Cgroup      string                     `json:"cgroup"`
			UsernsMode  string                     `json:"userns_mode"`
			Devices     []json.RawMessage          `json:"devices"`
			VolumesFrom []string                   `json:"volumes_from"`
			CapDrop     []string                   `json:"cap_drop"`
			Volumes     []struct {
				Type   string `json:"type"`
				Source string `json:"source"`
				Target string `json:"target"`
			} `json:"volumes"`
		} `json:"services"`
		Secrets map[string]composeFileResource `json:"secrets"`
		Configs map[string]composeFileResource `json:"configs"`
	}
	if err := json.Unmarshal(output, &compose); err != nil {
		return nil, fmt.Errorf("decode Compose configuration: %w", err)
	}
	// A Compose secret or config file is mounted into a service. It must not
	// reach the Runtime credentials under /factory/assignment.
	for _, resources := range []map[string]composeFileResource{compose.Secrets, compose.Configs} {
		for name, resource := range resources {
			if resource.File != "" && !pathWithin(assignment.WorkspaceFolder, resource.File) {
				return nil, fmt.Errorf("Compose secret or config %q reads a file outside the assigned checkout", name)
			}
		}
	}
	for name, service := range compose.Services {
		if service.Privileged || service.Pid == "host" || service.NetworkMode == "host" {
			return nil, fmt.Errorf("Compose service %q requests a forbidden host boundary", name)
		}
		if service.Ipc == "host" || service.Uts == "host" || service.Cgroup == "host" || service.UsernsMode == "host" || len(service.Devices) > 0 {
			return nil, fmt.Errorf("Compose service %q requests a forbidden host boundary", name)
		}
		for _, source := range service.VolumesFrom {
			if strings.HasPrefix(source, "container:") {
				return nil, fmt.Errorf("Compose service %q shares volumes with a container outside the Compose project", name)
			}
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

func waitForDocker(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, dockerReadyTimeout)
	defer cancel()
	for attempt := 0; attempt < dockerReadyAttempts; attempt++ {
		command := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}")
		if err := command.Run(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(dockerReadyPollInterval):
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
	ctx, end := context.WithTimeout(parent, browserImagePullTimeout)
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
		return errBrowserImageStartup
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
			return errBrowserImageStartup
		}
		failure := strings.ToLower(string(diagnostic.Bytes()))
		if strings.Contains(failure, "no space left on device") || strings.Contains(failure, "disk quota exceeded") {
			return errBrowserImageStorageExhausted
		}
		if !retryableImageDownload(string(diagnostic.Bytes())) {
			return errors.New("browser tools image download failed; check registry connectivity and approved CA trust")
		}
		// An immutable image acquisition can safely recover before any browser
		// exists. Keep the original startup deadline and one worker; never
		// repeat an App call or model request.
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errBrowserImageStartup
		case <-timer.C:
		}
		if confirmed() {
			return nil
		}
		retryDelay = min(retryDelay*2, 2*time.Second)
	}
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
	if err := requireNativeDependencyReference(ctx, assignment); err != nil {
		return devcontainerResult{}, fmt.Errorf("%w: %w", errDevcontainerNotStarted, err)
	}
	if err := removePreviousPrimary(ctx, assignment); err != nil {
		return devcontainerResult{}, fmt.Errorf("%w: %w", errDevcontainerNotStarted, err)
	}
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	arguments := []string{
		"up",
		"--workspace-folder", assignment.WorkspaceFolder,
		"--config", configPath,
		// CLI results on stdout remain JSON. Plain stderr keeps build lines
		// usable in the bounded tail: one oversized JSON raw event would
		// otherwise discard its actual terminal cause with the whole frame.
		"--log-format", "text",
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
	if assignment.nativeActorUID != "" {
		// Compose creates its network during up. Defer user commands until the
		// exact primary and its actual Actor-private gateway can be inspected.
		arguments = append(arguments, "--skip-post-create")
	}
	// A compatible prebuild is already selected by EffectiveConfiguration.
	// --cache-from would ask the CLI to build again; for an image-only Compose
	// service CLI 0.89.0 even emits an invalid service-level cache_from field.
	// If consumer preparation was unavailable, preserve normal startup instead.
	command := exec.CommandContext(ctx, "devcontainer", arguments...)
	command.Env = devcontainerEnvironment(assignment)
	var stdout bytes.Buffer
	var diagnostic devcontainerFailureOutput
	command.Stdout = &stdout
	command.Stderr = &diagnostic
	if err := command.Run(); err != nil {
		detail := devcontainerFailureDiagnostic(stdout.String(), diagnostic.String(), assignment)
		for _, line := range strings.Split(stdout.String(), "\n") {
			var failure struct {
				Outcome     string `json:"outcome"`
				Description string `json:"description"`
			}
			if json.Unmarshal([]byte(line), &failure) == nil && failure.Outcome == "error" {
				for _, hook := range []string{"onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"} {
					if strings.Contains(failure.Description, hook) {
						if detail != "" {
							return devcontainerResult{}, fmt.Errorf("Dev Container %s failed: %s", hook, detail)
						}
						return devcontainerResult{}, fmt.Errorf("Dev Container %s failed; check the repository hook and its environment grants", hook)
					}
				}
			}
		}
		if detail != "" {
			return devcontainerResult{}, fmt.Errorf("start Dev Container: %w: %s", err, detail)
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
	if assignment.nativeActorUID != "" {
		if err := runNativeLifecycle(ctx, assignment, result); err != nil {
			return devcontainerResult{}, err
		}
	}
	// A standalone primary has no Compose owner. Keep its actual CLI identity;
	// exact attempt/generation and primary ID own browser access and cleanup.
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
	if err := copyChildExecutable(ctx, result.ContainerID, executable, connectorPath); err != nil {
		return err
	}
	if err := exec.CommandContext(ctx, "docker", "cp", temporaryName, result.ContainerID+":"+assignmentPath).Run(); err != nil {
		return fmt.Errorf("copy Connector child assignment: %w", err)
	}
	if err := injectApprovedTools(ctx, assignment, result.ContainerID); err != nil {
		return err
	}
	if err := prepareChildPermissions(ctx, result.ContainerID, connectorPath, assignmentPath); err != nil {
		return err
	}
	transport, err := nativeChildTransport(ctx, result.ContainerID, assignment.Generation)
	if err != nil {
		return err
	}
	arguments := append([]string{"exec", "--interactive", "--user", result.RemoteUser}, transport...)
	arguments = append(arguments, result.ContainerID, connectorPath, "child", "--assignment", assignmentPath, "--token-stdin")
	command := exec.CommandContext(ctx, "docker", arguments...)
	credentials, _ := json.Marshal(map[string]any{"token": token, "environment": assignment.RuntimeEnvironment})
	command.Stdin = strings.NewReader(string(credentials))
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start Connector child: %w", err)
	}
	go func() { reportChildExit(os.Stderr, assignment, command.Wait()) }()
	return nil
}

// reportChildExit records how the injected child process ended. Credentials
// travel only on its stdin, so the exit status is safe to log.
func reportChildExit(output io.Writer, assignment Assignment, err error) {
	if err == nil {
		fmt.Fprintf(output, "Connector child for attempt %s generation %d exited\n", assignment.RuntimeAttemptID, assignment.Generation)
		return
	}
	fmt.Fprintf(output, "Connector child for attempt %s generation %d exited: %v\n", assignment.RuntimeAttemptID, assignment.Generation, err)
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
		if output, err := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID, "mkdir", "-p", "/opt/factory/language-tools/runtime").CombinedOutput(); err != nil {
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
		if output, err := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID, "mkdir", "-p", "/opt/factory/opencode").CombinedOutput(); err != nil {
			return fmt.Errorf("create OpenCode destination: %w: %s", err, output)
		}
		if output, err := exec.CommandContext(ctx, "docker", "cp", "/opt/factory/opencode/server", containerID+":/opt/factory/opencode/server").CombinedOutput(); err != nil {
			return fmt.Errorf("inject native OpenCode server: %w: %s", err, output)
		}
		if err := copyChildExecutable(ctx, containerID, tool, "/opt/factory/opencode/bun"); err != nil {
			return fmt.Errorf("inject OpenCode: %w", err)
		}
		if output, err := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID, "chmod", "0555", "/opt/factory/opencode/bun").CombinedOutput(); err != nil {
			return fmt.Errorf("prepare OpenCode: %w: %s", err, output)
		}
	}
	if needsVerification {
		if output, err := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID, "mkdir", "-p", "/opt/factory").CombinedOutput(); err != nil {
			return fmt.Errorf("create Forgejo Runner destination: %w: %s", err, output)
		}
		if err := copyChildExecutable(ctx, containerID, "/usr/local/bin/forgejo-runner", "/opt/factory/forgejo-runner"); err != nil {
			return fmt.Errorf("inject Forgejo Runner: %w", err)
		}
		if output, err := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID, "chmod", "0555", "/opt/factory/forgejo-runner").CombinedOutput(); err != nil {
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
	owner := containerOrigin{state.RuntimeAttemptID, state.Generation, state.ComposeProjectName}
	if state.ContainerOrigin != nil {
		owner = *state.ContainerOrigin
	}
	if state.ContainerID != "" {
		container, err := inspectContainer(state.ContainerID)
		if err == nil && container.Config.Labels["com.docker.compose.project"] == "" {
			if container.ID != state.ContainerID || container.Config.Labels[attemptLabel] != owner.AttemptID || container.Config.Labels[generationLabel] != strconv.FormatUint(owner.Generation, 10) {
				return errors.New("Standalone cleanup identity changed")
			}
			if exec.Command("docker", "rm", "-f", state.ContainerID).Run() != nil {
				return errors.New("standalone runtime cleanup failed")
			}
		}
	}
	if owner.ComposeProjectName == "" {
		return nil
	}
	label := "com.docker.compose.project=" + owner.ComposeProjectName
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
