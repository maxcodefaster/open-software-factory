package connector

import (
	"context"
	"encoding/json"
	"errors"
	imagereference "github.com/distribution/reference"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func prebuildRoot(assignment Assignment) (string, error) {
	if !identityPattern.MatchString(assignment.RepositoryIdentity) || !filepath.IsAbs(assignment.WorkspaceFolder) || filepath.Clean(assignment.WorkspaceFolder) != assignment.WorkspaceFolder {
		return "", errors.New("prebuild requires an assigned canonical Project checkout")
	}
	resolved, err := filepath.EvalSymlinks(assignment.WorkspaceFolder)
	if err != nil || resolved != assignment.WorkspaceFolder {
		return "", errors.New("prebuild canonical checkout cannot be retargeted")
	}
	root := filepath.Join(filepath.Dir(assignment.WorkspaceFolder), ".factory-project-prebuilds")
	if err := os.Mkdir(root, 0700); err != nil && !os.IsExist(err) {
		return "", errors.New("prebuild operation storage is unavailable")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("prebuild operation storage is unsafe")
	}
	return root, nil
}

func prebuildPath(snapshot, base, relative string) (string, error) {
	path := filepath.Join(base, relative)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !pathWithin(snapshot, resolved) {
		return "", errors.New("prebuild recipe leaves its committed snapshot")
	}
	return resolved, nil
}

type prebuildSnapshotOwner struct {
	Repository string `json:"repository"`
	Commit     string `json:"commit"`
}

func removeInterruptedPrebuildSnapshots(root, repository string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "snapshot-") {
			continue
		}
		if !entry.IsDir() {
			return errors.New("prebuild snapshot storage is unsafe")
		}
		directory := filepath.Join(root, entry.Name())
		encoded, err := os.ReadFile(filepath.Join(directory, "owner.json"))
		var owner prebuildSnapshotOwner
		if err != nil || json.Unmarshal(encoded, &owner) != nil || owner.Repository != repository || !prebuildCommit.MatchString(owner.Commit) {
			return errors.New("interrupted prebuild snapshot ownership is not confirmed")
		}
		if err := os.RemoveAll(directory); err != nil {
			return errors.New("interrupted prebuild snapshot could not be removed")
		}
	}
	return nil
}

func preparePrebuildInputWith(ctx context.Context, assignment Assignment, request PrebuildRequest, read prebuildConfigurationReader) (prebuildInput, string, error) {
	var input prebuildInput
	root, err := prebuildRoot(assignment)
	if err != nil {
		return input, "", err
	}
	if !prebuildCommit.MatchString(request.Commit) || (request.Platform != "linux/amd64" && request.Platform != "linux/arm64") {
		return input, "", errors.New("prebuild requires an exact Git commit and supported target architecture")
	}
	named, err := imagereference.ParseNormalizedNamed(request.ImageRepository)
	if err != nil || !imagereference.IsNameOnly(named) || !strings.Contains(request.ImageRepository, "/") || !strings.HasSuffix(request.ImageRepository, "/"+assignment.RepositoryIdentity) {
		return input, "", errors.New("prebuild output must be a registry repository owned by this Project")
	}
	owner, err := prebuildGit(ctx, assignment.WorkspaceFolder, "config", "--local", "--get", "factory.repositoryIdentity")
	if err != nil || owner != assignment.RepositoryIdentity {
		return input, "", errors.New("prebuild checkout belongs to a different Project")
	}
	commit, err := prebuildGit(ctx, assignment.WorkspaceFolder, "rev-parse", "--verify", request.Commit+"^{commit}")
	if err != nil || commit != request.Commit {
		return input, "", errors.New("prebuild exact commit is unavailable")
	}
	tree, err := prebuildGit(ctx, assignment.WorkspaceFolder, "rev-parse", request.Commit+"^{tree}")
	if err != nil {
		return input, "", err
	}
	if err := removeInterruptedPrebuildSnapshots(root, assignment.RepositoryIdentity); err != nil {
		return input, "", err
	}
	staging, err := os.MkdirTemp(root, "snapshot-")
	if err != nil {
		return input, "", err
	}
	snapshotOwner, _ := json.Marshal(prebuildSnapshotOwner{assignment.RepositoryIdentity, request.Commit})
	if err := os.WriteFile(filepath.Join(staging, "owner.json"), snapshotOwner, 0600); err != nil {
		return input, "", err
	}
	snapshot := filepath.Join(staging, "checkout")
	complete := false
	defer func() {
		if !complete {
			os.RemoveAll(staging)
		}
	}()
	// A separate checkout freezes Dockerfiles, lockfiles and local Features. No
	// reset, clean, hooks or writes ever touch the canonical human/Agent tree.
	clone := prebuildCommand(ctx, "/tmp", "git", "-c", "core.hooksPath=/dev/null",
		"-c", "safe.directory="+assignment.WorkspaceFolder,
		"-c", "safe.directory="+filepath.Join(assignment.WorkspaceFolder, ".git"),
		"clone", "--no-hardlinks", "--no-checkout", "--", assignment.WorkspaceFolder, snapshot)
	// Local upload-pack clears command-line and environment config overrides on
	// some Git versions. A root-private config trusts only the validated checkout
	// and is inherited by that subprocess, without changing installation config.
	trust := filepath.Join(staging, "git-trust")
	for _, directory := range []string{assignment.WorkspaceFolder, filepath.Join(assignment.WorkspaceFolder, ".git")} {
		if prebuildCommand(ctx, "/tmp", "git", "config", "--file", trust, "--add", "safe.directory", directory).Run() != nil {
			return input, "", errors.New("prebuild exact checkout trust could not be configured")
		}
	}
	clone.Env = assignedEnvironment(clone.Env, map[string]string{"GIT_CONFIG_GLOBAL": trust})
	if clone.Run() != nil {
		return input, "", errors.New("prebuild snapshot could not be created")
	}
	if _, err := prebuildGit(ctx, snapshot, "checkout", "--detach", request.Commit); err != nil {
		return input, "", err
	}
	if err := os.RemoveAll(filepath.Join(snapshot, ".git")); err != nil {
		return input, "", err
	}
	var snapshotBytes int64
	entries := 0
	if err := filepath.WalkDir(snapshot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		entries++
		info, err := entry.Info()
		if err != nil {
			return err
		}
		snapshotBytes += info.Size()
		if entries > 100000 || snapshotBytes > 1<<30 {
			return errors.New("prebuild committed snapshot exceeds its size bound")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil || !pathWithin(snapshot, resolved) {
				return errors.New("prebuild snapshot contains an external or dangling symlink")
			}
		}
		return nil
	}); err != nil {
		return input, "", err
	}
	configuration := request.Configuration
	if configuration == "" {
		configuration = assignment.DevcontainerPath
	}
	if filepath.IsAbs(configuration) || filepath.Clean(configuration) != configuration || strings.HasPrefix(configuration, "..") {
		return input, "", errors.New("prebuild configuration must stay within its committed snapshot")
	}
	configPath, err := prebuildPath(snapshot, snapshot, configuration)
	if err != nil {
		return input, "", err
	}
	configSource, err := os.ReadFile(configPath)
	if err != nil || len(configSource) > 1<<20 || strings.Contains(string(configSource), "${localEnv:") {
		return input, "", errors.New("prebuild configuration cannot depend on the producer environment")
	}
	config, err := read(ctx, snapshot, configPath)
	if err != nil {
		return input, "", err
	}
	if config.DockerComposeFile != nil {
		return input, "", errors.New("prebuild producer accepts a standalone image or Dockerfile recipe; Compose consumers use its digest")
	}
	var immutable []string
	var dockerfileRelative string
	if config.Image != "" {
		key, err := projectImageKey(config.Image)
		if err != nil {
			if err := acquireProjectImage(ctx, config.Image); err != nil {
				return input, "", err
			}
			key, err = resolveProjectImage(ctx, config.Image)
			if err != nil {
				return input, "", err
			}
			var raw map[string]json.RawMessage
			if json.Unmarshal(config.Document, &raw) != nil {
				return input, "", errors.New("Resolved image recipe is unavailable; normal startup remains available")
			}
			raw["image"], _ = json.Marshal(key)
			resolved, _ := json.Marshal(raw)
			if err := os.WriteFile(configPath, resolved, 0600); err != nil {
				return input, "", err
			}
		}
		immutable = append(immutable, key)
	} else {
		dockerfile := config.Build.Dockerfile
		if dockerfile == "" {
			dockerfile = config.Dockerfile
		}
		if dockerfile == "" {
			return input, "", errors.New("prebuild recipe requires an image or Dockerfile")
		}
		contextPath := config.Build.Context
		if contextPath == "" {
			contextPath = "."
		}
		if _, err := prebuildPath(snapshot, filepath.Dir(configPath), contextPath); err != nil {
			return input, "", err
		}
		path, err := prebuildPath(snapshot, filepath.Dir(configPath), dockerfile)
		if err != nil {
			return input, "", err
		}
		dockerfileRelative, err = filepath.Rel(snapshot, path)
		if err != nil {
			return input, "", err
		}
		source, err := os.ReadFile(path)
		if err != nil || len(source) > 1<<20 {
			return input, "", errors.New("prebuild Dockerfile is unavailable or too large")
		}
		immutable, err = prebuildDockerInputs(string(source))
		if err != nil {
			resolved, inputs, resolveErr := resolvePrebuildDockerInputs(ctx, string(source))
			if resolveErr != nil {
				return input, "", resolveErr
			}
			immutable = inputs
			if err := os.WriteFile(path, []byte(resolved), 0600); err != nil {
				return input, "", err
			}
		}
	}
	remoteFeatures := false
	for feature := range config.Features {
		if strings.HasPrefix(feature, ".") {
			path, err := prebuildPath(snapshot, filepath.Dir(configPath), feature)
			if err != nil {
				return input, "", err
			}
			if !pathWithin(filepath.Join(snapshot, ".devcontainer"), path) {
				return input, "", errors.New("pinned CLI requires local Features inside the committed .devcontainer folder")
			}
			if _, err := prebuildPath(snapshot, path, "devcontainer-feature.json"); err != nil {
				return input, "", err
			}
		} else {
			remoteFeatures = true
		}
	}
	if remoteFeatures {
		features, err := resolvePrebuildFeatures(ctx, snapshot, configPath, config.Features)
		if err != nil {
			return input, "", err
		}
		immutable = append(immutable, features...)
	}
	sort.Strings(immutable)
	input = prebuildInput{Version: 1, Repository: assignment.RepositoryIdentity, Commit: request.Commit, Tree: tree, Configuration: configuration, Dockerfile: dockerfileRelative, Platform: request.Platform, ImageRepository: named.Name(), CLIVersion: prebuildCLIVersion, CLIIntegrity: prebuildCLIIntegrity, ImmutableInputs: immutable}
	if assignment.EnvironmentVersion != nil {
		input.EnvironmentVersion = *assignment.EnvironmentVersion
	}
	complete = true
	return input, snapshot, nil
}

// Upstream resolves ordinary Feature tags and their dependencies. Freeze only
// the isolated snapshot, leaving authored configuration and lockfiles untouched.
func resolvePrebuildFeatures(ctx context.Context, snapshot, configPath string, requested map[string]json.RawMessage) ([]string, error) {
	out, err := prebuildCommand(ctx, "/tmp", "devcontainer", "read-configuration", "--workspace-folder", snapshot, "--config", configPath, "--include-features-configuration", "--oci-auth-hardening", "--log-format", "json").Output()
	if err != nil || len(out) > 4<<20 {
		return nil, errors.New("Project Feature preparation failed; normal startup remains available")
	}
	var result struct {
		Configuration map[string]json.RawMessage `json:"configuration"`
		Features      struct {
			Sets []struct {
				ComputedDigest string `json:"computedDigest"`
				Features       []struct {
					Version   string                     `json:"version"`
					DependsOn map[string]json.RawMessage `json:"dependsOn"`
				} `json:"features"`
				Source struct {
					Type   string `json:"type"`
					ID     string `json:"userFeatureId"`
					Digest string `json:"manifestDigest"`
				} `json:"sourceInformation"`
			} `json:"featureSets"`
		} `json:"featuresConfiguration"`
	}
	found := false
	for _, line := range strings.Split(string(out), "\n") {
		if json.Unmarshal([]byte(line), &result) == nil && result.Configuration != nil {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("Resolved Project Features are unavailable")
	}
	type featureLock struct {
		Version   string   `json:"version"`
		Resolved  string   `json:"resolved"`
		Integrity string   `json:"integrity"`
		DependsOn []string `json:"dependsOn,omitempty"`
	}
	locked := map[string]featureLock{}
	var inputs []string
	for _, set := range result.Features.Sets {
		if set.Source.Type != "oci" {
			continue
		}
		id := set.Source.ID
		named, err := imagereference.ParseNormalizedNamed(id)
		if err != nil {
			return nil, errors.New("Resolved Feature reference is invalid")
		}
		key, err := projectImageKey(imagereference.TrimNamed(named).Name() + "@" + set.Source.Digest)
		if err != nil {
			return nil, errors.New("Resolved Feature digest is invalid")
		}
		if len(set.Features) != 1 || set.ComputedDigest != set.Source.Digest {
			return nil, errors.New("Resolved Feature content was not confirmed")
		}
		var dependencies []string
		for dependency := range set.Features[0].DependsOn {
			dependencies = append(dependencies, dependency)
		}
		sort.Strings(dependencies)
		entry := featureLock{set.Features[0].Version, key, set.ComputedDigest, dependencies}
		locked[id] = entry
		inputs = append(inputs, key)
	}
	for id := range requested {
		if strings.HasPrefix(id, ".") {
			continue
		}
		_, ok := locked[id]
		if !ok {
			return nil, errors.New("Project Feature resolution was incomplete")
		}
	}
	encoded, _ := json.MarshalIndent(map[string]any{"features": locked}, "", "  ")
	lockName := "devcontainer-lock.json"
	if strings.HasPrefix(filepath.Base(configPath), ".") {
		lockName = ".devcontainer-lock.json"
	}
	if os.WriteFile(filepath.Join(filepath.Dir(configPath), lockName), append(encoded, '\n'), 0600) != nil {
		return nil, errors.New("Resolved Feature lock could not be prepared")
	}
	return inputs, nil
}

func resolvePrebuildDockerInputs(ctx context.Context, source string) (string, []string, error) {
	stages := map[string]bool{}
	lines := strings.Split(source, "\n")
	for index, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.EqualFold(fields[0], "FROM") {
			continue
		}
		position := 1
		if strings.HasPrefix(fields[position], "--platform=") {
			position++
		}
		if position >= len(fields) {
			return "", nil, errors.New("Dockerfile FROM is incomplete")
		}
		reference := fields[position]
		if !stages[strings.ToLower(reference)] && !strings.EqualFold(reference, "scratch") {
			if _, err := projectImageKey(reference); err != nil {
				if strings.Contains(reference, "$") {
					return "", nil, errors.New("Dynamic Dockerfile input uses normal startup")
				}
				if err := acquireProjectImage(ctx, reference); err != nil {
					return "", nil, err
				}
				digest, err := resolveProjectImage(ctx, reference)
				if err != nil {
					return "", nil, err
				}
				fields[position] = digest
				lines[index] = strings.Join(fields, " ")
			}
		}
		if len(fields) > position+2 && strings.EqualFold(fields[position+1], "AS") {
			stages[strings.ToLower(fields[position+2])] = true
		}
	}
	resolved := strings.Join(lines, "\n")
	inputs, err := prebuildDockerInputs(resolved)
	return resolved, inputs, err
}

func prebuildDockerInputs(source string) ([]string, error) {
	var inputs []string
	stages := map[string]bool{}
	for _, line := range strings.Split(source, "\n") {
		line = strings.TrimSpace(line)
		var reference string
		if strings.HasPrefix(strings.ToLower(line), "# syntax=") {
			reference = strings.TrimSpace(strings.SplitN(line, "=", 2)[1])
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.EqualFold(fields[0], "FROM") {
			index := 1
			if strings.HasPrefix(fields[index], "--platform=") {
				index++
			}
			if index >= len(fields) {
				return nil, errors.New("prebuild Dockerfile FROM is incomplete")
			}
			reference = fields[index]
			if stages[strings.ToLower(reference)] || strings.EqualFold(reference, "scratch") {
				reference = ""
			}
			if len(fields) > index+2 && strings.EqualFold(fields[index+1], "AS") {
				stages[strings.ToLower(fields[index+2])] = true
			}
		}
		if len(fields) >= 2 && strings.EqualFold(fields[0], "COPY") {
			for _, field := range fields[1:] {
				if from, ok := strings.CutPrefix(field, "--from="); ok && !stages[strings.ToLower(from)] {
					if _, err := projectImageKey(from); err != nil {
						return nil, errors.New("prebuild COPY image inputs must be a named prior stage or exact digest")
					}
					reference = from
				}
			}
		}
		if reference != "" {
			key, err := projectImageKey(reference)
			if err != nil {
				return nil, errors.New("prebuild Dockerfile image inputs must be explicit registry digests")
			}
			inputs = append(inputs, key)
		}
	}
	if len(stages) == 0 && len(inputs) == 0 {
		return nil, errors.New("prebuild Dockerfile has no explicit image input")
	}
	return inputs, nil
}

func readPrebuildConfiguration(ctx context.Context, snapshot, configPath string) (prebuildConfiguration, error) {
	source, err := readPrebuildConfigurationDocument(ctx, snapshot, configPath)
	var config prebuildConfiguration
	if err != nil {
		return config, err
	}
	if json.Unmarshal(source, &config) != nil {
		return config, errors.New("Invalid resolved Dev Container recipe")
	}
	config.Document = source
	return config, nil
}

func readPrebuildConfigurationDocument(ctx context.Context, snapshot, configPath string) (json.RawMessage, error) {
	var result struct {
		Configuration json.RawMessage `json:"configuration"`
	}
	out, err := prebuildCommand(ctx, "/tmp", "devcontainer", "read-configuration", "--workspace-folder", snapshot, "--config", configPath, "--log-format", "json").Output()
	if err != nil || len(out) > 1<<20 {
		return result.Configuration, errors.New("prebuild Dev Container configuration could not be resolved")
	}
	for _, line := range strings.Split(string(out), "\n") {
		if json.Unmarshal([]byte(line), &result) == nil && len(result.Configuration) > 0 {
			return result.Configuration, nil
		}
	}
	return result.Configuration, errors.New("prebuild Dev Container recipe is unsupported or incomplete")
}
