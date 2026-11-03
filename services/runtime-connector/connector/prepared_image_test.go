package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicImageBuildDoesNotBindRuntimeOnlyEnvironmentVersions(t *testing.T) {
	assignment, revision := prebuildRepository(t)
	request := PrebuildRequest{Commit: revision, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}
	original, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, request)
	if err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Dir(snapshot))
	version := uint64(9)
	assignment.EnvironmentVersion = &version
	for _, scenario := range []struct {
		name        string
		environment runtimeEnvironment
		public      bool
	}{
		{"empty", runtimeEnvironment{Version: version}, true},
		{"runtime-only", runtimeEnvironment{Version: version, Bundle: environmentBundle{Variables: []environmentVariable{{Name: "APP_TOKEN", Value: "never-capture", Runtime: true}}}}, true},
		{"build-variable", runtimeEnvironment{Version: version, Bundle: environmentBundle{Variables: []environmentVariable{{Name: "BUILD_TOKEN", Build: true}}}}, false},
		{"registry", runtimeEnvironment{Version: version, Bundle: environmentBundle{Registries: []environmentRegistry{{Host: "registry.private"}}}}, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			assignment.PublicImageBuild = publicImageBuild(scenario.environment)
			assignment.BuildEnvironmentSHA256 = imageBuildEnvironmentSHA256(scenario.environment)
			if assignment.PublicImageBuild != scenario.public {
				t.Fatal("build-input classification differs from the resolved environment")
			}
			input, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, request)
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(filepath.Dir(snapshot))
			if (prebuildIdentity(input) == prebuildIdentity(original)) != scenario.public {
				t.Fatal("image identity either included runtime-only changes or omitted protected build inputs")
			}
		})
	}
	first := runtimeEnvironment{Version: version, Bundle: environmentBundle{
		Variables: []environmentVariable{{Name: "BUILD_TOKEN", Build: true, Value: "first-protected-build-value"}},
	}}
	second := first
	second.Bundle.Variables = []environmentVariable{{Name: "BUILD_TOKEN", Build: true, Value: "second-protected-build-value"}}
	if imageBuildEnvironmentSHA256(first) == imageBuildEnvironmentSHA256(second) {
		t.Fatal("independent environments with equal version numbers shared different protected build inputs")
	}
	if strings.Contains(imageBuildEnvironmentSHA256(first), "first-protected-build-value") {
		t.Fatal("image identity retained a protected value instead of its digest")
	}
	assignment.PublicImageBuild = false
	assignment.BuildEnvironmentSHA256 = imageBuildEnvironmentSHA256(first)
	firstInput, firstSnapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, request)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(firstSnapshot))
	assignment.BuildEnvironmentSHA256 = imageBuildEnvironmentSHA256(second)
	secondInput, secondSnapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, request)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(secondSnapshot))
	if prebuildIdentity(firstInput) == prebuildIdentity(secondInput) {
		t.Fatal("the actual image fingerprint omitted distinct protected build inputs")
	}
}

func TestPreparedImageRequiresCredentialFreeExactProjectMetadata(t *testing.T) {
	slot, _ := preparedFixture(t)
	source := *slot.Project
	source.PreparedImage = &PrebuildResult{
		Identity: strings.Repeat("a", 64),
		Image:    "registry.factory/prebuilds/" + source.RepositoryIdentity + "@sha256:" + strings.Repeat("b", 64),
	}
	if err := validatePreparedProject(source); err != nil {
		t.Fatal("public exact image metadata was rejected:", err)
	}
	for _, scenario := range []string{"owner", "digest", "identity", "control", "environment-version", "runtime-values", "registry-grants", "producer"} {
		t.Run(scenario, func(t *testing.T) {
			assignment := source
			image := *source.PreparedImage
			assignment.PreparedImage = &image
			switch scenario {
			case "owner":
				image.Image = "registry.factory/prebuilds/another-project@sha256:" + strings.Repeat("b", 64)
			case "digest":
				image.Image = "registry.factory/prebuilds/" + source.RepositoryIdentity + ":latest"
			case "identity":
				image.Identity = "unknown"
			case "control":
				assignment.ControlURL = "ws://factory.example/internal/runtime-connect"
			case "environment-version":
				version := uint64(1)
				assignment.EnvironmentVersion = &version
			case "runtime-values":
				assignment.RuntimeEnvironment = map[string]string{"APP_TOKEN": "never-capture"}
			case "registry-grants":
				assignment.DockerConfigDirectory = "/private/registry-grants"
			case "producer":
				assignment.Prebuild = &PrebuildAssignment{ID: "producer", Platform: "native", ImageRepository: "registry.factory/prebuilds/" + source.RepositoryIdentity}
			}
			if err := validatePreparedProject(assignment); err == nil {
				t.Fatal("unsafe image metadata entered a captured Project template")
			}
		})
	}
}

func TestPreparedImageUsesRealCommittedFingerprintAndPrivateImageObservation(t *testing.T) {
	assignment, revision := prebuildRepository(t)
	assignment.Revision = revision
	assignment.ControlURL = "ws://unassigned.invalid/"
	repository := "registry.factory/prebuilds/" + assignment.RepositoryIdentity
	input, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, PrebuildRequest{
		Commit: revision, Platform: "linux/arm64", ImageRepository: repository,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	image := repository + "@sha256:" + strings.Repeat("d", 64)
	result := PrebuildResult{Identity: prebuildIdentity(input), Image: image}
	directory := t.TempDir()
	trace := filepath.Join(directory, "commands")
	metadataPath := filepath.Join(directory, "image.json")
	metadata := []prebuildImage{{
		ID: "sha256:" + strings.Repeat("c", 64), RepoDigests: []string{image},
		OS: "linux", Architecture: "arm64",
	}}
	metadata[0].Config.Labels = map[string]string{prebuildLabel: result.Identity}
	writeMetadata := func() {
		t.Helper()
		encoded, err := json.Marshal(metadata)
		if err != nil || os.WriteFile(metadataPath, encoded, 0600) != nil {
			t.Fatal("write owned image observation")
		}
	}
	writeMetadata()
	script := fmt.Sprintf(`#!/bin/sh
set -eu
printf '%%s\n' "$*" >>%q
if [ "$1" = info ]; then printf 'linux/arm64\n'; exit 0; fi
if [ "$1 $2" = 'image inspect' ]; then
  if [ "$3" = --format ]; then printf '%%s\n' '%s'; else cat %q; fi
  exit 0
fi
echo 'unexpected image operation' >&2
exit 73
`, trace, `["`+image+`"]`, metadataPath)
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	if key := compatiblePrebuild(context.Background(), assignment, result, fixturePrebuildConfiguration); key != image {
		t.Fatal("clean template could not reuse its exact prepared image:", key)
	}
	for _, scenario := range []string{"fingerprint", "platform", "label", "dirty-source", "environment-version"} {
		t.Run(scenario, func(t *testing.T) {
			target, selected := assignment, result
			switch scenario {
			case "fingerprint":
				selected.Identity = strings.Repeat("e", 64)
			case "platform":
				metadata[0].Architecture = "amd64"
			case "label":
				metadata[0].Config.Labels[prebuildLabel] = strings.Repeat("f", 64)
			case "dirty-source":
				if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "untracked-source"), []byte("human edit"), 0600); err != nil {
					t.Fatal(err)
				}
				defer os.Remove(filepath.Join(assignment.WorkspaceFolder, "untracked-source"))
			case "environment-version":
				version := uint64(1)
				target.EnvironmentVersion = &version
			}
			writeMetadata()
			if key := compatiblePrebuild(context.Background(), target, selected, fixturePrebuildConfiguration); key != "" {
				t.Fatal("different or unconfirmed inputs reused a prepared image:", key)
			}
			metadata[0].Architecture = "arm64"
			metadata[0].Config.Labels[prebuildLabel] = result.Identity
			writeMetadata()
		})
	}
	commands, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"build ", "pull ", "login ", "run "} {
		if strings.Contains(string(commands), forbidden) {
			t.Fatalf("local immutable image reuse unexpectedly executed %q: %s", forbidden, commands)
		}
	}
}
