package connector

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestNativeDependencyRegistryBypassIsInternalAndExact(t *testing.T) {
	local := "sha256:" + strings.Repeat("a", 64)
	remote := projectImage("b")
	for _, internal := range []bool{false, true} {
		assignment := Assignment{}
		if internal {
			assignment.nativeActorUID = "owned-native-actor"
			assignment.preparedRootFSImage = local
		}
		images, found, err := assignment.registryProjectImages([]string{local, remote})
		if err != nil || found != internal {
			t.Fatalf("internal native image selection differs: %v", err)
		}
		calls := 0
		err = prepareProjectImagesWith(context.Background(), images, func(context.Context, string) error {
			calls++
			return nil
		})
		if internal {
			if err != nil || calls != 1 || len(images) != 1 || images[0] != remote {
				t.Fatal("the exact native dependency image was pulled or excluded a Registry dependency")
			}
		} else if err == nil || calls != 0 {
			t.Fatal("source-authored local image IDs bypassed normal admission")
		}
	}
	assignment := Assignment{preparedRootFSImage: local}
	if _, _, err := assignment.registryProjectImages([]string{local}); err == nil {
		t.Fatal("dependency image selection without native authority bypassed admission")
	}
	assignment.nativeActorUID = "owned-native-actor"
	if _, _, err := assignment.registryProjectImages([]string{"sha256:" + strings.Repeat("c", 64)}); err == nil {
		t.Fatal("an unrelated local image bypassed Registry admission")
	}
	references := []string{local}
	for _, digit := range "12345678" {
		references = append(references, projectImage(string(digit)))
	}
	if _, _, err := assignment.registryProjectImages(references); err == nil {
		t.Fatal("native dependency preparation removed an image from the existing admission bound")
	}
	content, _ := json.Marshal(assignment)
	if strings.Contains(string(content), local) || strings.Contains(string(content), assignment.nativeActorUID) {
		t.Fatal("native dependency authority became a wire-supplied assignment field")
	}
	assignment.nativeDependencyReference = "factory-native-dependencies:" + strings.Repeat("b", 64)
	images, found, err := assignment.registryProjectImages([]string{assignment.nativeDependencyReference, remote})
	if err != nil || !found || len(images) != 1 || images[0] != remote {
		t.Fatal("the verified native dependency reference lost its exact registry selection")
	}
}

func TestPrebuildHooksKeepRequiredProjectAndFeatureMetadata(t *testing.T) {
	metadata := `[{"id":"feature","postCreateCommand":"required Feature hook"},{"postCreateCommand":"required Project hook"},{"remoteUser":"node","workspaceFolder":"/workspace/project"}]`
	for _, nativeDependency := range []bool{false, true} {
		config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`"required Project hook"`)}
		if err := removePrebuiltProjectHooksFrom(config, metadata, nativeDependency); err != nil {
			t.Fatal(err)
		}
		if (config["postCreateCommand"] == nil) != nativeDependency {
			t.Fatal("only the internally selected dependency image may normalize duplicate CLI metadata")
		}
	}
	config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`"changed hook"`)}
	if err := removePrebuiltProjectHooksFrom(config, metadata, true); err == nil {
		t.Fatal("different required hooks reused previously built lifecycle metadata")
	}
}
