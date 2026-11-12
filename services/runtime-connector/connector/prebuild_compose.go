package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var composeEnvironmentReference = regexp.MustCompile(`\$[A-Za-z_{]`)
var composeServiceName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

func committedComposeFiles(root, configPath string, declaration any) ([]string, error) {
	var names []string
	switch value := declaration.(type) {
	case string:
		names = []string{value}
	case []any:
		for _, item := range value {
			name, ok := item.(string)
			if !ok {
				return nil, errors.New("prebuild Compose file declaration is invalid")
			}
			names = append(names, name)
		}
	case []string:
		names = value
	}
	if len(names) == 0 {
		return nil, errors.New("prebuild Compose requires explicit committed files")
	}
	files := make([]string, 0, len(names))
	for _, name := range names {
		path, err := committedComposePath(root, filepath.Dir(configPath), name)
		if err != nil {
			return nil, err
		}
		files = append(files, path)
	}
	return files, nil
}

func committedComposePath(root, base, name string) (string, error) {
	if name == "" {
		return "", errors.New("prebuild Compose path is empty")
	}
	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, path)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !pathWithin(root, resolved) {
		return "", errors.New("prebuild Compose path leaves its committed snapshot")
	}
	return resolved, nil
}

func immutablePrebuildImage(ctx context.Context, image string) (string, error) {
	key, err := projectImageKey(image)
	if err == nil {
		return key, nil
	}
	if err := acquireProjectImage(ctx, image); err != nil {
		return "", err
	}
	return resolveProjectImage(ctx, image)
}

// Resolve the real Compose merge with the pinned CLI's own Compose command.
// Only this isolated committed snapshot is rewritten. No services or lifecycle
// hooks run, and the producer's sanitized environment carries no Runtime grants.
func prepareComposePrebuild(ctx context.Context, snapshot, configPath string, config prebuildConfiguration, assignment Assignment) (prebuildConfiguration, []string, error) {
	files, err := committedComposeFiles(snapshot, configPath, config.DockerComposeFile)
	if err != nil {
		return config, nil, err
	}
	if err := admitComposePrebuildSources(snapshot, files); err != nil {
		return config, nil, err
	}
	arguments := []string{"compose"}
	for _, path := range files {
		arguments = append(arguments, "-f", path)
	}
	arguments = append(arguments, "config", "--format", "json", "--no-env-resolution", "--no-interpolate")
	command := prebuildCommand(ctx, "/tmp", "docker", arguments...)
	command.Dir = snapshot
	content, err := command.Output()
	var model map[string]json.RawMessage
	if err != nil || len(content) > 1<<20 || json.Unmarshal(content, &model) != nil {
		return config, nil, errors.New("prebuild Compose configuration could not be resolved")
	}
	var services map[string]map[string]json.RawMessage
	if json.Unmarshal(model["services"], &services) != nil || !composeServiceName.MatchString(config.Service) || services[config.Service] == nil {
		return config, nil, errors.New("prebuild Compose primary service is unavailable")
	}
	primary := services[config.Service]
	var immutable []string
	for name, service := range services {
		if !composeServiceName.MatchString(name) {
			return config, nil, errors.New("prebuild Compose service name is invalid")
		}
		// Only this committed, isolated snapshot is rewritten. No Runtime
		// variable or env-file value is resolved, passed to build, or copied
		// into its image. Consumers still use the original service files.
		delete(service, "environment")
		delete(service, "env_file")
		var image string
		if raw := service["image"]; raw != nil && json.Unmarshal(raw, &image) != nil {
			return config, nil, errors.New("prebuild Compose image is invalid")
		}
		build := service["build"]
		if build != nil && string(build) != "null" {
			dockerfile, contextPath, inputs, err := freezeComposePrebuildDockerfile(ctx, snapshot, filepath.Dir(files[0]), build)
			if err != nil {
				return config, nil, err
			}
			immutable = append(immutable, inputs...)
			if name == config.Service {
				config.Build.Dockerfile, _ = filepath.Rel(filepath.Dir(configPath), dockerfile)
				config.Build.Context, _ = filepath.Rel(filepath.Dir(configPath), contextPath)
			}
		} else {
			if image == "" {
				return config, nil, errors.New("prebuild Compose service has neither image nor build")
			}
			key, err := immutablePrebuildImage(ctx, image)
			if err != nil {
				return config, nil, err
			}
			service["image"], _ = json.Marshal(key)
			immutable = append(immutable, key)
			if name == config.Service {
				base := key
				selected, err := prepareNativePrebuildBase(ctx, assignment, key)
				if err != nil {
					return config, nil, err
				}
				if selected != nil {
					config.nativeBase = selected
				}
				// Give image-only primary services an owned image too. Compose's
				// build path does not consistently forward --label without Features.
				path := filepath.Join(filepath.Dir(configPath), ".factory-prebuild-base.Dockerfile")
				file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err != nil {
					return config, nil, errors.New("prebuild Compose private Dockerfile already has an owner")
				}
				_, writeErr := file.WriteString("FROM " + base + "\n")
				closeErr := file.Close()
				if err := errors.Join(writeErr, closeErr); err != nil {
					return config, nil, err
				}
				relative, _ := filepath.Rel(snapshot, path)
				primary["build"], _ = json.Marshal(map[string]string{"context": snapshot, "dockerfile": relative})
				// An immutable base digest is not a legal build-output tag.
				// Let the CLI name its private output, then publish our owned tag.
				delete(primary, "image")
				config.Build.Dockerfile = filepath.Base(path)
				config.Build.Context, _ = filepath.Rel(filepath.Dir(configPath), snapshot)
			}
		}
	}
	model["services"], _ = json.Marshal(services)
	resolved, _ := json.Marshal(model)
	if err := os.WriteFile(files[0], resolved, 0600); err != nil {
		return config, nil, err
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(config.Document, &document) != nil {
		return config, nil, errors.New("prebuild Compose Dev Container document is unavailable")
	}
	relative, _ := filepath.Rel(filepath.Dir(configPath), files[0])
	document["dockerComposeFile"], _ = json.Marshal([]string{relative})
	config.Document, _ = json.Marshal(document)
	if err := os.WriteFile(configPath, config.Document, 0600); err != nil {
		return config, nil, err
	}
	config.Image = ""
	return config, immutable, nil
}

func freezeComposePrebuildDockerfile(ctx context.Context, snapshot, base string, raw json.RawMessage) (string, string, []string, error) {
	var build struct {
		Context    string `json:"context"`
		Dockerfile string `json:"dockerfile"`
	}
	if len(raw) > 0 && raw[0] == '"' {
		if json.Unmarshal(raw, &build.Context) != nil {
			return "", "", nil, errors.New("prebuild Compose build is invalid")
		}
	} else {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &build) != nil || json.Unmarshal(raw, &fields) != nil {
			return "", "", nil, errors.New("prebuild Compose build is invalid")
		}
		for _, field := range []string{"additional_contexts", "dockerfile_inline", "secrets", "ssh"} {
			if value := fields[field]; value != nil && string(value) != "null" && string(value) != "[]" && string(value) != "{}" {
				return "", "", nil, fmt.Errorf("prebuild Compose %s requires normal startup", field)
			}
		}
	}
	if build.Context == "" {
		build.Context = "."
	}
	contextPath, err := committedComposePath(snapshot, base, build.Context)
	if err != nil {
		return "", "", nil, err
	}
	if build.Dockerfile == "" {
		build.Dockerfile = "Dockerfile"
	}
	path, err := committedComposePath(snapshot, contextPath, build.Dockerfile)
	if err != nil {
		return "", "", nil, err
	}
	source, err := os.ReadFile(path)
	if err != nil || len(source) > 1<<20 {
		return "", "", nil, errors.New("prebuild Compose Dockerfile is unavailable or too large")
	}
	inputs, err := prebuildDockerInputs(string(source))
	if err != nil {
		resolved, identities, err := resolvePrebuildDockerInputs(ctx, string(source))
		if err != nil {
			return "", "", nil, err
		}
		inputs = identities
		if err := os.WriteFile(path, []byte(resolved), 0600); err != nil {
			return "", "", nil, err
		}
	}
	return path, contextPath, inputs, nil
}

func configureComposePrebuildConsumer(root, configPath, directory, image string, config map[string]json.RawMessage) error {
	var declaration any
	var service string
	if json.Unmarshal(config["dockerComposeFile"], &declaration) != nil ||
		json.Unmarshal(config["service"], &service) != nil || !composeServiceName.MatchString(service) {
		return errors.New("prepared Compose primary service is unavailable")
	}
	files, err := committedComposeFiles(root, configPath, declaration)
	if err != nil {
		return err
	}
	// Absolute original file paths retain Compose's own relative-path base.
	// Reset only the primary build, keeping all mounts, dependency services,
	// environment, health checks and the Dev Container lifecycle hooks.
	name, _ := json.Marshal(service)
	reference, _ := json.Marshal(image)
	overlay := filepath.Join(directory, "compose.yaml")
	content := fmt.Sprintf("services:\n  %s:\n    image: %s\n    build: !reset null\n    pull_policy: never\n", name, reference)
	if err := os.WriteFile(overlay, []byte(content), 0600); err != nil {
		return err
	}
	config["dockerComposeFile"], _ = json.Marshal(append(files, overlay))
	return nil
}
