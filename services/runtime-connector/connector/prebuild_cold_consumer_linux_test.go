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

func coldPrebuildFixture(t *testing.T) (Assignment, parentState, string) {
	t.Helper()
	assignment, root := nativePrebuildConsumerRepository(t)
	assignment.RuntimeAttemptID = "owned-cold-prebuild"
	assignment.Generation = 1
	assignment.ComposeProjectName = "owned-cold-prebuild"
	assignment.PreserveWorkspace = true
	image := "registry.factory/prebuilds/" + assignment.RepositoryIdentity + "@sha256:" + strings.Repeat("c", 64)
	identity := strings.Repeat("e", 64)
	containerID := strings.Repeat("d", 64)
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	if err := os.MkdirAll(assignment.ConnectorStateDir, 0700); err != nil {
		t.Fatal(err)
	}
	// This is the same Parent's private, previously successful runtime state,
	// not a new compatible-prebuild claim against dirty Source.
	state := parentState{
		RuntimeAttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation,
		ContainerID: containerID, ComposeProjectName: assignment.ComposeProjectName,
		PreserveWorkspace: true, NativeActorUID: assignment.nativeActorUID,
		ContainerOrigin:    &containerOrigin{assignment.RuntimeAttemptID, assignment.Generation, assignment.ComposeProjectName},
		PrebuildCacheImage: image, PrebuildInputIdentity: identity,
	}
	// A paused user edited ordinary source. No temporary /dev/shm override
	// survives the cold process boundary.
	if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "app.txt"), []byte("offline edit\n"), 0644); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		t.Fatal(err)
	}
	cli := `#!/bin/sh
configuration="$(cat '` + configPath + `')"
while [ "$#" -gt 0 ]; do
 if [ "$1" = --override-config ]; then configuration="$(cat "$2")"; break; fi
 shift
done
printf '{"configuration":%s,"mergedConfiguration":{}}\n' "$configuration"
`
	labels, _ := json.Marshal(map[string]string{
		"factory.dev/prebuild-input": identity, "devcontainer.metadata": "[]",
	})
	container, _ := json.Marshal([]any{map[string]any{
		"Id": containerID, "Image": "sha256:" + strings.Repeat("b", 64),
		"Config": map[string]any{"Image": image, "Labels": map[string]string{
			attemptLabel: assignment.RuntimeAttemptID, generationLabel: "1",
			"com.docker.compose.project": assignment.ComposeProjectName,
		}},
		"State": map[string]any{"Running": false},
	}})
	docker := fmt.Sprintf(`#!/bin/sh
test "$DOCKER_HOST" = unix:///run/user/1000/docker.sock || exit 9
case "$1 $2" in
 "info --format") printf 'linux/arm64' ;;
 "image inspect")
   case "$4" in
    *RepoDigests*) printf '["%%s"]' "$5" ;;
    *Config.Labels*) printf '%%s' '%s' ;;
    *) printf '[{"Id":"sha256:%s","RepoDigests":["%s"],"Os":"linux","Architecture":"arm64","Config":{"Labels":{"factory.dev/prebuild-input":"%s"}}}]' ;;
   esac ;;
 "inspect "*) printf '%%s' '%s' ;;
 "ps -aq") printf '%%s' '%s' ;;
 *) exit 8 ;;
esac
`, labels, strings.Repeat("b", 64), image, identity, container, containerID)
	for name, script := range map[string]string{"devcontainer": cli, "docker": docker} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, err := nativePrebuildContext(context.Background(), assignment)
	if err != nil {
		t.Fatal(err)
	}
	state.PrebuildConfigurationSHA256, err = nativePrebuildConfigurationSHA256(ctx, assignment)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeParentState(assignment, state); err != nil {
		t.Fatal(err)
	}
	return assignment, state, root
}

func TestNativeColdPrebuildKeepsItsConfirmedImageAfterSourceEdits(t *testing.T) {
	assignment, state, _ := coldPrebuildFixture(t)
	cleanup, err := prepareFreshDevcontainer(context.Background(), &assignment, "owned-parent")
	defer cleanup()
	if err != nil || assignment.PrebuildCacheImage != state.PrebuildCacheImage || assignment.EffectiveConfiguration == "" {
		t.Fatalf("cold startup discarded its confirmed prepared image after an ordinary Source edit: image=%q config=%q err=%v",
			assignment.PrebuildCacheImage, assignment.EffectiveConfiguration, err)
	}
	content, err := os.ReadFile(filepath.Join(assignment.WorkspaceFolder, "app.txt"))
	if err != nil || string(content) != "offline edit\n" {
		t.Fatal("cold prebuild selection changed the user's saved Source")
	}
}

func TestNativeColdPrebuildKeepsStandaloneContainerOrigin(t *testing.T) {
	assignment, state, root := coldPrebuildFixture(t)
	state.ComposeProjectName = ""
	state.ContainerOrigin.ComposeProjectName = ""
	if err := writeParentState(assignment, state); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "bin", "docker")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	source := strings.Replace(string(content), `"com.docker.compose.project":"`+assignment.ComposeProjectName+`"`, `"com.docker.compose.project":""`, 1)
	if source == string(content) {
		t.Fatal("standalone-primary fixture did not change")
	}
	if err := os.WriteFile(path, []byte(source), 0755); err != nil {
		t.Fatal(err)
	}
	image, err := retainedNativePrebuild(context.Background(), assignment)
	if err != nil || image != state.PrebuildCacheImage {
		t.Fatalf("standalone continuation substituted a logical Compose origin: %q %v", image, err)
	}
}

func TestNativeColdPrebuildFingerprintsPublicConfigurationNotApplicationEdits(t *testing.T) {
	assignment, _, _ := coldPrebuildFixture(t)
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	if err := os.WriteFile(configPath, []byte(`{"dockerComposeFile":"compose.yaml","service":"app"}`), 0644); err != nil {
		t.Fatal(err)
	}
	composePath := filepath.Join(filepath.Dir(configPath), "compose.yaml")
	compose := "services:\n  app:\n    image: registry.factory/project:original\n    environment:\n      TOKEN: ${RUNTIME_ONLY_TOKEN}\n"
	if err := os.WriteFile(composePath, []byte(compose), 0644); err != nil {
		t.Fatal(err)
	}
	ctx, err := nativePrebuildContext(context.Background(), assignment)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := func() string {
		t.Helper()
		result, err := nativePrebuildConfigurationSHA256(ctx, assignment)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	original := fingerprint()
	t.Setenv("RUNTIME_ONLY_TOKEN", "a-fresh-runtime-value")
	if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "app.txt"), []byte("another offline change\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if current := fingerprint(); current != original {
		t.Fatal("application or resolved Runtime values changed the public configuration fingerprint")
	}
	if err := os.WriteFile(composePath, []byte(strings.ReplaceAll(compose, ":original", ":changed")), 0644); err != nil {
		t.Fatal(err)
	}
	if current := fingerprint(); current == original {
		t.Fatal("changed Compose recipe retained the old prepared-image configuration fingerprint")
	}
}

func TestNativeColdPrebuildRefusesChangedOwnershipOrRecipe(t *testing.T) {
	for _, field := range []string{"actor", "attempt", "generation", "origin", "compose", "image", "input", "config-hash", "config", "missing-container", "wrong-container-image", "digest", "platform", "state-missing", "state-mode", "state-symlink", "state-owner"} {
		t.Run(field, func(t *testing.T) {
			assignment, state, root := coldPrebuildFixture(t)
			statePath := filepath.Join(assignment.ConnectorStateDir, assignment.RuntimeAttemptID+"-1.json")
			switch field {
			case "actor":
				state.NativeActorUID = "other-actor"
			case "attempt":
				state.RuntimeAttemptID = "another-attempt"
			case "generation":
				state.Generation++
			case "origin":
				state.ContainerOrigin.Generation++
			case "compose":
				state.ComposeProjectName = "another-project"
			case "image":
				state.PrebuildCacheImage = "registry.factory/untrusted:latest"
			case "input":
				state.PrebuildInputIdentity = strings.Repeat("f", 64)
			case "config-hash":
				state.PrebuildConfigurationSHA256 = strings.Repeat("f", 64)
			case "config":
				if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath), []byte(`{"image":"different"}`), 0644); err != nil {
					t.Fatal(err)
				}
			case "missing-container":
				state.ContainerID = strings.Repeat("f", 64)
			case "wrong-container-image", "digest", "platform":
				path := filepath.Join(root, "bin", "docker")
				content, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				source := string(content)
				switch field {
				case "wrong-container-image":
					source = strings.ReplaceAll(source, `"Image":"sha256:`+strings.Repeat("b", 64)+`"`, `"Image":"unconfirmed"`)
				case "digest":
					source = strings.ReplaceAll(source, `"RepoDigests":["`+state.PrebuildCacheImage+`"]`, `"RepoDigests":[]`)
				case "platform":
					source = strings.ReplaceAll(source, `"Architecture":"arm64"`, `"Architecture":"amd64"`)
				}
				if string(content) == source {
					t.Fatal("negative fixture did not change")
				}
				if err := os.WriteFile(path, []byte(source), 0755); err != nil {
					t.Fatal(err)
				}
			}
			// Write the original filename even when the recorded owner differs.
			content, _ := json.Marshal(state)
			if err := os.WriteFile(statePath, content, 0600); err != nil {
				t.Fatal(err)
			}
			switch field {
			case "state-missing":
				if err := os.Remove(statePath); err != nil {
					t.Fatal(err)
				}
			case "state-mode":
				if err := os.Chmod(statePath, 0644); err != nil {
					t.Fatal(err)
				}
			case "state-symlink":
				if err := os.Rename(statePath, statePath+".other"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(statePath+".other", statePath); err != nil {
					t.Fatal(err)
				}
			case "state-owner":
				if err := os.Chown(statePath, 1000, 1000); err != nil {
					t.Fatal(err)
				}
			}
			cleanup, err := prepareFreshDevcontainer(context.Background(), &assignment, "owned-parent")
			defer cleanup()
			if err == nil || !strings.Contains(err.Error(), "retained prepared Dev Container") ||
				assignment.PrebuildCacheImage != "" || assignment.EffectiveConfiguration != "" {
				t.Fatalf("changed retained owner or recipe was not refused before fresh fallback: %v", err)
			}
		})
	}
}

func TestNativeColdPrebuildAllowsFreshSelectionOnlyWithoutAPrimary(t *testing.T) {
	assignment, _, root := coldPrebuildFixture(t)
	if err := os.Remove(filepath.Join(assignment.ConnectorStateDir, assignment.RuntimeAttemptID+"-1.json")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "bin", "docker")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	source := strings.Replace(string(content), `"ps -aq") printf '%s' '`+strings.Repeat("d", 64)+`' ;;`, `"ps -aq") exit 0 ;;`, 1)
	if source == string(content) {
		t.Fatal("fresh-primary fixture did not change")
	}
	if err := os.WriteFile(path, []byte(source), 0755); err != nil {
		t.Fatal(err)
	}
	image, err := retainedNativePrebuild(context.Background(), assignment)
	if err != nil || image != "" {
		t.Fatalf("first native start was not eligible for normal fresh selection: %q %v", image, err)
	}
}
