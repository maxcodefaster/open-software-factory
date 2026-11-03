package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreparedRootFSBindsItsExactCleanPrimaryAndObservesLostOutput(t *testing.T) {
	for _, scenario := range []string{"captured", "lost-output", "foreign-primary", "foreign-attempt", "invalid-image"} {
		t.Run(scenario, func(t *testing.T) {
			slot, _ := preparedFixture(t)
			source := *slot.Project
			id := strings.Repeat("a", 64)
			project := &preparedProject{assignment: source,
				result: devcontainerResult{ContainerID: id},
				origin: containerOrigin{source.RuntimeAttemptID, source.Generation, source.ComposeProjectName}}
			var container inspectedContainer
			container.ID, container.State.Running = id, true
			container.Config.Labels = map[string]string{
				attemptLabel: source.RuntimeAttemptID, generationLabel: "1",
				"com.docker.compose.project": source.ComposeProjectName,
			}
			container.HostConfig.CapDrop = []string{"ALL"}
			var image prebuildImage
			image.ID = "sha256:" + strings.Repeat("b", 64)
			image.Config.Labels = map[string]string{
				attemptLabel: source.RuntimeAttemptID, generationLabel: "1", preparedRootFSLabel: id,
			}
			switch scenario {
			case "foreign-primary":
				image.Config.Labels[preparedRootFSLabel] = strings.Repeat("c", 64)
			case "foreign-attempt":
				image.Config.Labels[attemptLabel] = "another-template"
			case "invalid-image":
				image.ID = "mutable:tag"
			}
			directory := t.TempDir()
			trace := filepath.Join(directory, "commands")
			script := `#!/bin/sh
printf '%s\n' "$*" >>"$FACTORY_ROOTFS_TRACE"
case "$1 $2" in
  "image ls") if [ -f "$FACTORY_ROOTFS_TRACE.created" ]; then printf '%s' "$FACTORY_ROOTFS_ID"; fi ;;
  "image inspect") cat "$FACTORY_ROOTFS_IMAGE" ;;
  "inspect "*) cat "$FACTORY_ROOTFS_CONTAINER" ;;
  "commit "*) touch "$FACTORY_ROOTFS_TRACE.created"; if [ "$FACTORY_ROOTFS_CASE" = lost-output ]; then exit 1; fi ;;
  *) exit 1 ;;
esac
`
			for name, value := range map[string]any{"container": []inspectedContainer{container}, "image": []prebuildImage{image}} {
				content, _ := json.Marshal(value)
				if err := os.WriteFile(filepath.Join(directory, name+".json"), content, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_ROOTFS_TRACE", trace)
			t.Setenv("FACTORY_ROOTFS_ID", image.ID)
			t.Setenv("FACTORY_ROOTFS_IMAGE", filepath.Join(directory, "image.json"))
			t.Setenv("FACTORY_ROOTFS_CONTAINER", filepath.Join(directory, "container.json"))
			t.Setenv("FACTORY_ROOTFS_CASE", scenario)
			err := project.captureRootFS(context.Background())
			healthy := scenario == "captured" || scenario == "lost-output"
			if healthy != (err == nil) {
				t.Fatalf("clean primary image ownership result differs: %v", err)
			}
			if healthy {
				if project.rootFSImage != image.ID {
					t.Fatal("capture did not retain the observed immutable image")
				}
				if err := project.captureRootFS(context.Background()); err != nil {
					t.Fatal(err)
				}
				commands, _ := os.ReadFile(trace)
				if strings.Count(string(commands), "\ncommit ") != 1 {
					t.Fatalf("observing the cache repeated its mutation: %s", commands)
				}
			}
			// A resolved Runtime bundle must never enter a dependency image.
			project.assignment.RuntimeEnvironment = map[string]string{"APP_TOKEN": "fresh-authority"}
			if err := project.captureRootFS(context.Background()); err == nil {
				t.Fatal("a granted primary was eligible for a later clean template")
			}
		})
	}
}

func TestPreparedRootFSRegistryBypassIsInternalAndExact(t *testing.T) {
	local := "sha256:" + strings.Repeat("a", 64)
	remote := projectImage("b")
	for _, internal := range []bool{false, true} {
		assignment := Assignment{}
		if internal {
			assignment.preparedRootFSImage = local
		}
		images, found, err := assignment.registryProjectImages([]string{local, remote})
		if err != nil || found != internal {
			t.Fatalf("internal image selection differs: %v", err)
		}
		calls := 0
		err = prepareProjectImagesWith(context.Background(), images, func(context.Context, string) error {
			calls++
			return nil
		})
		if internal {
			if err != nil || calls != 1 || len(images) != 1 || images[0] != remote {
				t.Fatal("the exact private image was pulled or excluded a Registry dependency")
			}
		} else if err == nil || calls != 0 {
			t.Fatal("source-authored local image IDs bypassed normal admission")
		}
	}
	assignment := Assignment{preparedRootFSImage: local}
	if _, _, err := assignment.registryProjectImages([]string{"sha256:" + strings.Repeat("c", 64)}); err == nil {
		t.Fatal("an unrelated local image bypassed Registry admission")
	}
	references := []string{local}
	for _, digit := range "12345678" {
		references = append(references, projectImage(string(digit)))
	}
	if _, _, err := assignment.registryProjectImages(references); err == nil {
		t.Fatal("the private cache removed an image from the existing admission bound")
	}
	content, _ := json.Marshal(assignment)
	if strings.Contains(string(content), local) {
		t.Fatal("private cache authority became a wire-supplied assignment field")
	}
}

func TestPreparedRootFSKeepsRequiredHooksOnceAcrossContainerMetadata(t *testing.T) {
	metadata := `[{"id":"feature","postCreateCommand":"required Feature hook"},{"postCreateCommand":"required Project hook"},{"remoteUser":"node","workspaceFolder":"/workspace/project"}]`
	for _, capturedPrimary := range []bool{false, true} {
		config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`"required Project hook"`)}
		if err := removePrebuiltProjectHooksFrom(config, metadata, capturedPrimary); err != nil {
			t.Fatal(err)
		}
		if (config["postCreateCommand"] == nil) != capturedPrimary {
			t.Fatal("only the exact captured primary may normalize the CLI consumer's extra entry")
		}
	}
	config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`"changed hook"`)}
	if err := removePrebuiltProjectHooksFrom(config, metadata, true); err == nil {
		t.Fatal("a different required hook reused captured lifecycle metadata")
	}
}
