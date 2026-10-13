package connector

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func prebuildEnvironment(home string) []string {
	return []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + home, "DOCKER_CONFIG=" + filepath.Join(home, ".docker"),
		"DOCKER_HOST=unix:///var/run/docker.sock", "DOCKER_BUILDKIT=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
}

func prebuildCommand(ctx context.Context, home, name string, arguments ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, name, arguments...)
	command.Env = prebuildEnvironment(home)
	if directory, ok := ctx.Value(dockerConfigContextKey{}).(string); ok {
		command.Env = assignedEnvironment(command.Env, map[string]string{"DOCKER_CONFIG": directory})
	}
	if ca, ok := ctx.Value(registryCAContextKey{}).(string); ok {
		command.Env = assignedEnvironment(command.Env, map[string]string{"NODE_EXTRA_CA_CERTS": ca})
	}
	return command
}

func prebuildGit(ctx context.Context, repository string, args ...string) (string, error) {
	base := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "safe.directory=" + repository, "-C", repository}
	out, err := prebuildCommand(ctx, "/tmp", "git", append(base, args...)...).Output()
	if err != nil || len(out) > 4096 {
		return "", errors.New("prebuild exact repository input is unavailable")
	}
	return strings.TrimSpace(string(out)), nil
}

type prebuildImage struct {
	ID           string   `json:"Id"`
	RepoDigests  []string `json:"RepoDigests"`
	Architecture string   `json:"Architecture"`
	OS           string   `json:"Os"`
	Config       struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

func inspectPrebuild(ctx context.Context, operation prebuildOperation, reference string) (prebuildImage, error) {
	var images []prebuildImage
	out, err := prebuildCommand(ctx, filepath.Join(operation.Directory, "home"), "docker", "image", "inspect", reference).Output()
	if err != nil || len(out) > 1<<20 || json.Unmarshal(out, &images) != nil || len(images) != 1 {
		return prebuildImage{}, errPrebuildImageUnavailable
	}
	image := images[0]
	if image.Config.Labels[prebuildLabel] != operation.Identity || image.OS+"/"+image.Architecture != operation.Input.Platform {
		return prebuildImage{}, errors.New("prebuild image ownership or architecture differs")
	}
	return image, nil
}

func buildProjectPrebuild(ctx context.Context, operation prebuildOperation, snapshot string) (string, error) {
	if image, err := inspectPrebuild(ctx, operation, operation.Tag); err == nil {
		return image.ID, nil
	} else if !errors.Is(err, errPrebuildImageUnavailable) {
		return "", err
	}
	home := filepath.Join(operation.Directory, "home")
	if err := os.MkdirAll(home, 0700); err != nil {
		return "", err
	}
	version, err := prebuildCommand(ctx, home, "devcontainer", "--version").Output()
	if err != nil || strings.TrimSpace(string(version)) != prebuildCLIVersion {
		return "", errors.New("prebuild requires the exact pinned Dev Containers CLI")
	}
	if operation.Input.Dockerfile != "" {
		path, err := prebuildPath(snapshot, snapshot, operation.Input.Dockerfile)
		if err != nil {
			return "", err
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		// CLI 0.89.0 forwards --label in its image/Feature path, but not its
		// Dockerfile path. Put ordinary image metadata in this private snapshot
		// instead. Each selectable stage ends with the exact ownership label.
		if err := os.WriteFile(path, []byte(prebuildLabeledDockerfile(string(source), operation.Identity)), 0600); err != nil {
			return "", err
		}
	}
	arguments := []string{"build", "--workspace-folder", snapshot, "--config", filepath.Join(snapshot, operation.Input.Configuration), "--image-name", operation.Tag, "--platform", operation.Input.Platform, "--label", prebuildLabel + "=" + operation.Identity, "--oci-auth-hardening"}
	if _, err := os.Stat(filepath.Join(filepath.Dir(filepath.Join(snapshot, operation.Input.Configuration)), "devcontainer-lock.json")); err == nil {
		arguments = append(arguments, "--frozen-lockfile")
	}
	command := prebuildCommand(ctx, home, "devcontainer", arguments...)
	// Full upstream output stays outside product state, and cannot disclose
	// registry diagnostics or repository-controlled text through this command.
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if command.Run() != nil {
		return "", errors.New("Project prebuild failed; check the committed recipe, immutable inputs and registry trust")
	}
	image, err := inspectPrebuild(ctx, operation, operation.Tag)
	if err != nil {
		return "", err
	}
	return image.ID, nil
}

func prebuildLabeledDockerfile(source, identity string) string {
	var result strings.Builder
	started := false
	label := "LABEL " + prebuildLabel + "=" + identity + "\n"
	for _, line := range strings.Split(source, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.EqualFold(fields[0], "FROM") {
			if started {
				result.WriteString(label)
			}
			started = true
		}
		result.WriteString(line)
		result.WriteByte('\n')
	}
	result.WriteString(label)
	return result.String()
}

func pushProjectPrebuild(ctx context.Context, operation prebuildOperation, imageID string) (string, error) {
	image, err := inspectPrebuild(ctx, operation, operation.Tag)
	if errors.Is(err, errPrebuildImageUnavailable) {
		// A published artifact can outlive private cache eviction after a lost
		// acknowledgement. Recover its exact label/platform/ID before any retry.
		if prebuildCommand(ctx, filepath.Join(operation.Directory, "home"), "docker", "pull", operation.Tag).Run() == nil {
			image, err = inspectPrebuild(ctx, operation, operation.Tag)
		}
	}
	if err != nil || image.ID != imageID {
		return "", errors.New("prebuild local artifact no longer matches its persisted result")
	}
	if prebuildCommand(ctx, filepath.Join(operation.Directory, "home"), "docker", "push", operation.Tag).Run() != nil {
		return "", errors.New("Project prebuild publication failed; check approved registry connectivity and trust")
	}
	// Pull the publication name to confirm the registry acknowledgement and
	// ownership before returning a digest. A retry pushes the same local image.
	if prebuildCommand(ctx, filepath.Join(operation.Directory, "home"), "docker", "pull", operation.Tag).Run() != nil {
		return "", errors.New("Project prebuild publication could not be confirmed")
	}
	confirmed, err := inspectPrebuild(ctx, operation, operation.Tag)
	if err != nil || confirmed.ID != imageID {
		return "", errors.New("published prebuild does not match its built image")
	}
	for _, digest := range confirmed.RepoDigests {
		key, err := projectImageKey(digest)
		if err == nil && strings.HasPrefix(key, operation.Input.ImageRepository+"@") {
			return key, nil
		}
	}
	return "", errors.New("published prebuild has no confirmed registry digest")
}
