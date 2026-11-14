package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// This is continuation of a successful primary in the same native Actor, not
// cache compatibility for a new checkout. Ordinary Source edits must not change
// the image selected before Suspend.
func retainedNativePrebuild(ctx context.Context, assignment Assignment) (string, error) {
	if assignment.nativeActorUID == "" {
		return "", nil
	}
	ctx, err := nativePrebuildContext(ctx, assignment)
	if err != nil {
		return "", err
	}
	directory := assignment.ConnectorStateDir
	if directory == "" {
		directory = "/var/lib/factory/runtime-connector"
	}
	path := filepath.Join(directory, assignment.RuntimeAttemptID+"-"+strconv.FormatUint(assignment.Generation, 10)+".json")
	denied := errors.New("retained prepared Dev Container identity is unavailable; existing Source and runtime retained")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		// No record is normal before the first primary. It must not turn a
		// known container with missing private state into fresh hook dispatch.
		output, err := runtimeDockerCommand(ctx, "ps", "-aq", "--no-trunc",
			"--filter", "label="+attemptLabel+"="+assignment.RuntimeAttemptID,
			"--filter", "label="+generationLabel+"="+strconv.FormatUint(assignment.Generation, 10)).Output()
		if err != nil || len(output) > 4096 || strings.TrimSpace(string(output)) != "" {
			return "", denied
		}
		return "", nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return "", denied
	}
	var stat unix.Stat_t
	if unix.Lstat(path, &stat) != nil || stat.Uid != uint32(os.Geteuid()) {
		return "", denied
	}
	content, err := readNativePrebuildRecipeFile(path)
	var state parentState
	if err != nil || json.Unmarshal(content, &state) != nil ||
		state.RuntimeAttemptID != assignment.RuntimeAttemptID || state.Generation != assignment.Generation ||
		state.NativeActorUID != assignment.nativeActorUID {
		return "", denied
	}
	if state.PrebuildCacheImage == "" && state.PrebuildInputIdentity == "" && state.PrebuildConfigurationSHA256 == "" {
		return "", nil
	}
	key, err := projectImageKey(state.PrebuildCacheImage)
	if err != nil || key != state.PrebuildCacheImage || !regexpIdentity(state.PrebuildInputIdentity) ||
		!regexpIdentity(state.PrebuildConfigurationSHA256) || len(state.ContainerID) != 64 ||
		state.PreserveWorkspace != assignment.PreserveWorkspace || state.ContainerOrigin == nil ||
		state.ContainerOrigin.AttemptID != assignment.RuntimeAttemptID ||
		state.ContainerOrigin.Generation != assignment.Generation ||
		state.ContainerOrigin.ComposeProjectName != state.ComposeProjectName ||
		(state.ComposeProjectName != "" && state.ComposeProjectName != assignment.ComposeProjectName) {
		return "", denied
	}
	configuration, err := nativePrebuildConfigurationSHA256(ctx, assignment)
	if err != nil || configuration != state.PrebuildConfigurationSHA256 {
		return "", errors.New("retained prepared Dev Container recipe changed; existing Source and runtime retained")
	}
	platform, err := runtimePrebuildPlatform(ctx)
	if err != nil {
		return "", denied
	}
	operation := prebuildOperation{Identity: state.PrebuildInputIdentity, Directory: directory, Input: prebuildInput{Platform: platform}}
	image, err := inspectPrebuild(ctx, operation, key)
	if err != nil || !prebuildImageID.MatchString(image.ID) {
		return "", denied
	}
	digestConfirmed := false
	for _, reference := range image.RepoDigests {
		canonical, err := projectImageKey(reference)
		digestConfirmed = digestConfirmed || (err == nil && canonical == key)
	}
	output, err := runtimeDockerCommand(ctx, "inspect", state.ContainerID).Output()
	var containers []inspectedContainer
	if err != nil || len(output) > 1<<20 || json.Unmarshal(output, &containers) != nil || len(containers) != 1 || !digestConfirmed {
		return "", denied
	}
	container := containers[0]
	owner := *state.ContainerOrigin
	if container.ID != state.ContainerID || container.Config.Labels[attemptLabel] != owner.AttemptID ||
		container.Config.Labels[generationLabel] != strconv.FormatUint(owner.Generation, 10) ||
		container.Config.Labels["com.docker.compose.project"] != owner.ComposeProjectName {
		return "", denied
	}
	// The CLI can derive an image from the prepared one. The immutable original
	// container ID and its inherited input/platform bind that actual primary too.
	if !prebuildImageID.MatchString(container.Image) {
		return "", denied
	}
	if _, err := inspectPrebuild(ctx, operation, container.Image); err != nil {
		return "", denied
	}
	return key, nil
}

// Keep only public recipe fingerprints and immutable image metadata in Parent
// state. Temporary overrides and resolved Runtime grants are recreated per boot.
func rememberNativePrebuild(ctx context.Context, assignment *Assignment) error {
	ctx, err := nativePrebuildContext(ctx, *assignment)
	if err != nil {
		return err
	}
	key, err := projectImageKey(assignment.PrebuildCacheImage)
	if err != nil || key != assignment.PrebuildCacheImage {
		return errors.New("selected prepared image identity is unavailable")
	}
	output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{json .Config.Labels}}", key).Output()
	var labels map[string]string
	if err != nil || len(output) > 1<<20 || json.Unmarshal(output, &labels) != nil || !regexpIdentity(labels[prebuildLabel]) {
		return errors.New("selected prepared image input is unavailable")
	}
	configuration, err := nativePrebuildConfigurationSHA256(ctx, *assignment)
	if err != nil {
		return err
	}
	assignment.prebuildInputIdentity = labels[prebuildLabel]
	assignment.prebuildConfigurationSHA256 = configuration
	return nil
}

func readNativePrebuildRecipeFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("prepared Dev Container recipe file is unavailable")
	}
	content, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(content) > 1<<20 {
		return nil, errors.New("prepared Dev Container recipe file is too large")
	}
	return content, nil
}

func nativePrebuildConfigurationSHA256(ctx context.Context, assignment Assignment) (string, error) {
	configPath, err := prebuildPath(assignment.WorkspaceFolder, assignment.WorkspaceFolder, assignment.DevcontainerPath)
	if err != nil {
		return "", err
	}
	config, err := readPrebuildConfiguration(ctx, assignment.WorkspaceFolder, configPath)
	if err != nil {
		return "", err
	}
	files := []string{configPath}
	if config.DockerComposeFile != nil {
		compose, err := committedComposeFiles(assignment.WorkspaceFolder, configPath, config.DockerComposeFile)
		if err != nil {
			return "", err
		}
		files = append(files, compose...)
	}
	dockerfile := config.Dockerfile
	if config.Build.Dockerfile != "" {
		dockerfile = config.Build.Dockerfile
	}
	if dockerfile != "" {
		path, err := prebuildPath(assignment.WorkspaceFolder, filepath.Dir(configPath), dockerfile)
		if err != nil {
			return "", err
		}
		files = append(files, path)
	}
	type recipeFile struct {
		Path    string `json:"path"`
		Content []byte `json:"content"`
	}
	recipe := make([]recipeFile, 0, len(files))
	for _, path := range files {
		content, err := readNativePrebuildRecipeFile(path)
		if err != nil {
			return "", err
		}
		name, err := filepath.Rel(assignment.WorkspaceFolder, path)
		if err != nil {
			return "", err
		}
		recipe = append(recipe, recipeFile{name, content})
	}
	encoded, err := json.Marshal(recipe)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
