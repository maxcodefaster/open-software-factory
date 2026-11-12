package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func composePrebuildRepository(t *testing.T) (Assignment, string) {
	t.Helper()
	assignment, _ := prebuildRepository(t)
	files := map[string]string{
		".devcontainer/devcontainer.json": `{"dockerComposeFile":"compose.json","service":"workspace","remoteUser":"node","postCreateCommand":"required-project-setup"}`,
		".devcontainer/compose.json":      `{"services":{"workspace":{"build":{"context":"..","dockerfile":".devcontainer/Dockerfile"},"volumes":["..:/workspace/project"],"depends_on":["database"]},"database":{"image":"postgres@sha256:` + strings.Repeat("b", 64) + `","volumes":["data:/var/lib/postgresql/data"]}},"volumes":{"data":{}}}`,
	}
	for path, content := range files {
		if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, path), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Compose toolchain"}} {
		if output, err := exec.Command("git", append([]string{"-C", assignment.WorkspaceFolder}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("Compose fixture: %s: %v", output, err)
		}
	}
	out, err := exec.Command("git", "-C", assignment.WorkspaceFolder, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return assignment, strings.TrimSpace(string(out))
}

func composePrebuildDocker(t *testing.T) {
	t.Helper()
	directory := t.TempDir()
	script := `#!/bin/sh
set -eu
test "$1" = compose
shift
test "$1" = -f
file="$2"
case "$*" in *--no-interpolate*) ;; *) exit 1 ;; esac
cat "$file"
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestPrebuildComposeUsesCommittedPrimaryAndDependencyInputs(t *testing.T) {
	assignment, commit := composePrebuildRepository(t)
	composePrebuildDocker(t)
	input, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, PrebuildRequest{
		Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one",
	})
	if err != nil {
		t.Fatalf("Compose Project cannot prepare its toolchain: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	if input.Commit != commit || input.Dockerfile != ".devcontainer/Dockerfile" ||
		!strings.Contains(strings.Join(input.ImmutableInputs, "\n"), "node@sha256:"+strings.Repeat("a", 64)) ||
		!strings.Contains(strings.Join(input.ImmutableInputs, "\n"), "postgres@sha256:"+strings.Repeat("b", 64)) {
		t.Fatalf("Compose preparation lost exact inputs: %+v", input)
	}
	var config map[string]json.RawMessage
	encoded, err := os.ReadFile(filepath.Join(snapshot, assignment.DevcontainerPath))
	if err != nil || json.Unmarshal(encoded, &config) != nil ||
		string(config["postCreateCommand"]) != `"required-project-setup"` ||
		string(config["service"]) != `"workspace"` {
		t.Fatal("Compose preparation lost the required hook or selected service")
	}
	authored, err := os.ReadFile(filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	if err != nil || strings.Contains(string(authored), "factory-prebuild") {
		t.Fatal("Compose preparation changed canonical Source")
	}
}

func TestPrebuildComposeImageOnlyPrimaryUsesAnOwnedBuildOutput(t *testing.T) {
	assignment, _ := composePrebuildRepository(t)
	composePrebuildDocker(t)
	source := `{"services":{"workspace":{"image":"node@sha256:` + strings.Repeat("a", 64) + `"}}}`
	if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, ".devcontainer", "compose.json"), []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "image-only Compose"}} {
		if output, err := exec.Command("git", append([]string{"-C", assignment.WorkspaceFolder}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("Compose fixture: %s: %v", output, err)
		}
	}
	out, _ := exec.Command("git", "-C", assignment.WorkspaceFolder, "rev-parse", "HEAD").Output()
	input, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, PrebuildRequest{
		Commit: strings.TrimSpace(string(out)), Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	var model struct {
		Services map[string]map[string]json.RawMessage `json:"services"`
	}
	resolved, err := os.ReadFile(filepath.Join(snapshot, ".devcontainer", "compose.json"))
	if err != nil || json.Unmarshal(resolved, &model) != nil ||
		model.Services["workspace"]["image"] != nil || model.Services["workspace"]["build"] == nil {
		t.Fatalf("owned Compose build would try to tag an immutable base digest: %s: %v", resolved, err)
	}
	dockerfile, err := os.ReadFile(filepath.Join(snapshot, input.Dockerfile))
	if err != nil || !strings.Contains(string(dockerfile), "FROM docker.io/library/node@sha256:"+strings.Repeat("a", 64)) {
		t.Fatalf("image-only primary lost its exact immutable base: %s: %v", dockerfile, err)
	}
}

func TestPrebuildComposeRejectsProducerEnvironmentInterpolation(t *testing.T) {
	assignment, _ := composePrebuildRepository(t)
	composePrebuildDocker(t)
	path := filepath.Join(assignment.WorkspaceFolder, ".devcontainer", "compose.json")
	content := `{"services":{"workspace":{"image":"${PROTECTED_IMAGE}"}}}`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "environment-dependent Compose"}} {
		if output, err := exec.Command("git", append([]string{"-C", assignment.WorkspaceFolder}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("Compose fixture: %s: %v", output, err)
		}
	}
	out, _ := exec.Command("git", "-C", assignment.WorkspaceFolder, "rev-parse", "HEAD").Output()
	_, _, err := prepareFixturePrebuildInput(context.Background(), assignment, PrebuildRequest{
		Commit: strings.TrimSpace(string(out)), Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one",
	})
	if err == nil || !strings.Contains(err.Error(), "environment") {
		t.Fatalf("environment-dependent Compose must fail closed, got %v", err)
	}
}

func TestPrebuildComposeRuntimeEnvironmentIsExcludedWithoutChangingConsumerSource(t *testing.T) {
	assignment, _ := composePrebuildRepository(t)
	composePrebuildDocker(t)
	path := filepath.Join(assignment.WorkspaceFolder, ".devcontainer", "compose.json")
	content := `{"services":{"workspace":{"image":"node@sha256:` + strings.Repeat("a", 64) + `","environment":{"DATABASE_URL":"${DATABASE_URL:?Set DATABASE_URL in Factory environment settings}","BETTER_AUTH_SECRET":"${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in Factory environment settings}","BETTER_AUTH_URL":"${BETTER_AUTH_URL:-http://localhost:4300}"},"depends_on":["database"],"volumes":["..:/workspace/project"]},"database":{"image":"postgres@sha256:` + strings.Repeat("b", 64) + `","environment":{"POSTGRES_PASSWORD":"${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in Factory environment settings}"},"volumes":["data:/var/lib/postgresql/data"]}},"volumes":{"data":{}}}`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Runtime-only Compose environment"}} {
		if output, err := exec.Command("git", append([]string{"-C", assignment.WorkspaceFolder}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("Compose fixture: %s: %v", output, err)
		}
	}
	out, _ := exec.Command("git", "-C", assignment.WorkspaceFolder, "rev-parse", "HEAD").Output()
	input, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, PrebuildRequest{Commit: strings.TrimSpace(string(out)), Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	if input.Version != 3 {
		t.Fatal("Runtime-free producer did not retain its distinct recipe version")
	}
	resolved, err := os.ReadFile(filepath.Join(snapshot, ".devcontainer", "compose.json"))
	var model struct {
		Services map[string]map[string]json.RawMessage `json:"services"`
	}
	if err != nil || json.Unmarshal(resolved, &model) != nil {
		t.Fatal("private producer Compose is unavailable", err)
	}
	for name, service := range model.Services {
		if service["environment"] != nil || service["env_file"] != nil || strings.Contains(string(resolved), "${") {
			t.Fatalf("Runtime settings entered the private producer %s: %s", name, resolved)
		}
	}
	authored, err := os.ReadFile(path)
	if err != nil || string(authored) != content {
		t.Fatal("producer modified authored Runtime environment")
	}
	var config map[string]json.RawMessage
	declaration, err := os.ReadFile(filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	if err != nil || json.Unmarshal(declaration, &config) != nil {
		t.Fatal("authored Dev Container is unavailable")
	}
	directory := t.TempDir()
	if err := configureComposePrebuildConsumer(assignment.WorkspaceFolder, filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath), directory, "registry.factory/prebuilds/project-one@sha256:"+strings.Repeat("c", 64), config); err != nil {
		t.Fatal(err)
	}
	var files []string
	if json.Unmarshal(config["dockerComposeFile"], &files) != nil || len(files) != 2 || files[0] != path {
		t.Fatal("consumer lost the original Runtime settings")
	}
}

func TestStarterComposeRuntimeSettingsAreNotProducerInputs(t *testing.T) {
	root, err := filepath.Abs("../../../templates/starter-app")
	if err != nil {
		t.Fatal(err)
	}
	if selected := os.Getenv("FACTORY_STARTER_TEMPLATE_DIRECTORY"); selected != "" {
		root = selected
	}
	path := filepath.Join(root, ".devcontainer", "compose.yaml")
	if err := admitComposePrebuildSources(root, []string{path}); err != nil {
		t.Fatalf("shipped Starter Runtime settings are not build inputs: %v", err)
	}
}

func TestPrebuildComposeSourceReferencesCannotEscapeThroughIncludesOrAliases(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "compose.yaml")
	outside := filepath.Join(t.TempDir(), "outside.yaml")
	if err := os.WriteFile(outside, []byte("services: {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{
		fmt.Sprintf("include:\n  - %q\n", outside),
		fmt.Sprintf("services:\n  app:\n    extends:\n      file: %q\n      service: app\n", outside),
		fmt.Sprintf("secrets:\n  key:\n    file: %q\n", outside),
		fmt.Sprintf("services:\n  app:\n    env_file:\n      - path: %q\n", outside),
		"services:\n  app:\n    image: \"\\u0024PROTECTED_IMAGE\"\n",
		"x-environment: &environment \"${PROTECTED_IMAGE}\"\nservices:\n  app:\n    image: *environment\n",
	} {
		if err := os.WriteFile(path, []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
		if err := admitComposePrebuildSources(root, []string{path}); err == nil {
			t.Fatalf("admitted external or environment-dependent Compose source: %s", source)
		}
	}
}

func TestPrebuildComposeConsumerKeepsPrimaryHooksAndOriginalServiceFiles(t *testing.T) {
	assignment, _ := composePrebuildRepository(t)
	directory := t.TempDir()
	source, err := os.ReadFile(filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(source, &document); err != nil {
		t.Fatal(err)
	}
	image := "registry.factory/prebuilds/project-one@sha256:" + strings.Repeat("c", 64)
	if err := configureComposePrebuildConsumer(assignment.WorkspaceFolder,
		filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath), directory, image, document); err != nil {
		t.Fatal(err)
	}
	var files []string
	if err := json.Unmarshal(document["dockerComposeFile"], &files); err != nil ||
		len(files) != 2 || files[0] != filepath.Join(assignment.WorkspaceFolder, ".devcontainer/compose.json") {
		t.Fatalf("consumer lost original Compose path semantics: %s: %v", document["dockerComposeFile"], err)
	}
	if string(document["postCreateCommand"]) != `"required-project-setup"` ||
		string(document["remoteUser"]) != `"node"` || string(document["service"]) != `"workspace"` {
		t.Fatal("consumer lost required lifecycle or user configuration")
	}
	overlay, err := os.ReadFile(files[1])
	if err != nil || !strings.Contains(string(overlay), image) ||
		!strings.Contains(string(overlay), "build: !reset null") || strings.Contains(string(overlay), "database:") {
		t.Fatalf("consumer changed more than the primary image: %s: %v", overlay, err)
	}
}

func TestPrebuildComposeBuildUsesNativePlatformWithoutUnsupportedCLIFlag(t *testing.T) {
	directory := t.TempDir()
	snapshot := t.TempDir()
	identity := strings.Repeat("a", 64)
	imageID := "sha256:" + strings.Repeat("b", 64)
	marker := filepath.Join(directory, "built")
	log := filepath.Join(directory, "arguments")
	docker := fmt.Sprintf(`#!/bin/sh
set -eu
case "$1" in
  info) printf 'linux/aarch64\n' ;;
  image)
    test -f %q
    printf '%%s\n' '[{"Id":"%s","Os":"linux","Architecture":"arm64","Config":{"Labels":{"factory.dev/prebuild-input":"%s"}}}]'
    ;;
  *) exit 1 ;;
esac
`, marker, imageID, identity)
	devcontainer := fmt.Sprintf(`#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf '0.89.0\n'; exit 0; fi
printf '%%s\n' "$*" > %q
touch %q
`, log, marker)
	for name, content := range map[string]string{"docker": docker, "devcontainer": devcontainer} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	result, err := buildProjectPrebuild(context.Background(), prebuildOperation{
		Identity: identity, Directory: directory, Tag: "registry.factory/prebuilds/project-one:owned",
		Input: prebuildInput{Configuration: ".devcontainer/devcontainer.json", Platform: "linux/arm64", ComposeService: "workspace"},
	}, snapshot)
	if err != nil || result != imageID {
		t.Fatalf("Compose build did not confirm the exact native image: %s: %v", result, err)
	}
	arguments, err := os.ReadFile(log)
	if err != nil || strings.Contains(string(arguments), "--platform") ||
		!strings.Contains(string(arguments), "--image-name registry.factory/prebuilds/project-one:owned") ||
		!strings.Contains(string(arguments), "--oci-auth-hardening") {
		t.Fatalf("Compose build used unsupported or unscoped CLI arguments: %s: %v", arguments, err)
	}
}
