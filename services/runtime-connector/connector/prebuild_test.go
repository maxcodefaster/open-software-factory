package connector

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func prebuildRepository(t *testing.T) (Assignment, string) {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(filepath.Join(directory, ".devcontainer"), 0755); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	directory = canonical
	files := map[string]string{
		".devcontainer/devcontainer-lock.json":            `{"features":{}}`,
		".devcontainer/devcontainer.json":                 `{"build":{"dockerfile":"Dockerfile","context":".."},"features":{"./feature":{}}}`,
		".devcontainer/Dockerfile":                        "FROM node@sha256:" + strings.Repeat("a", 64) + "\nCOPY package-lock.json /opt/seed/package-lock.json\n",
		".devcontainer/feature/devcontainer-feature.json": `{"id":"fixture","version":"1.0.0","name":"Fixture"}`,
		".devcontainer/feature/install.sh":                "#!/bin/sh\nprintf locked > /opt/feature-proof\n",
		"package-lock.json":                               `{"lockfileVersion":3,"packages":{}}`,
	}
	for name, content := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(directory, name)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", directory}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("fixture Git: %s: %v", out, err)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "--initial-branch=main")
	git("config", "factory.repositoryIdentity", "project-one")
	git("add", ".")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "exact recipe")
	return Assignment{RuntimeAttemptID: "owned-fixture-attempt", RepositoryIdentity: "project-one", WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json"}, git("rev-parse", "HEAD")
}

func fixturePrebuildConfiguration(_ context.Context, _ string, path string) (prebuildConfiguration, error) {
	var config prebuildConfiguration
	encoded, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(encoded, &config)
	}
	config.Document = encoded
	return config, err
}

func prepareFixturePrebuildInput(ctx context.Context, assignment Assignment, request PrebuildRequest) (prebuildInput, string, error) {
	return preparePrebuildInputWith(ctx, assignment, request, fixturePrebuildConfiguration)
}

func TestPrebuildUsesCommittedInputsAndSeparatesIdentity(t *testing.T) {
	assignment, commit := prebuildRepository(t)
	request := PrebuildRequest{Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}
	input, snapshot, err := prepareFixturePrebuildInput(context.Background(), assignment, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "package-lock.json"), []byte("human dirty buffer"), 0644); err != nil {
		t.Fatal(err)
	}
	locked, err := os.ReadFile(filepath.Join(snapshot, "package-lock.json"))
	if err != nil || string(locked) == "human dirty buffer" {
		t.Fatal("prebuild used the mutable canonical checkout")
	}
	if input.Commit != commit || input.Tree == "" || input.Dockerfile != ".devcontainer/Dockerfile" || len(input.ImmutableInputs) != 1 || input.ImmutableInputs[0] != "docker.io/library/node@sha256:"+strings.Repeat("a", 64) {
		t.Fatalf("incomplete exact inputs: %+v", input)
	}
	identity := prebuildIdentity(input)
	input.Platform = "linux/amd64"
	if prebuildIdentity(input) == identity {
		t.Fatal("architecture is not bound to artifact identity")
	}
	input.Platform = request.Platform
	input.CLIIntegrity = "changed"
	if prebuildIdentity(input) == identity {
		t.Fatal("CLI integrity is not bound to artifact identity")
	}
}

func TestPrebuildRejectsWrongOwnerMutableInputsAndInfrastructurePaths(t *testing.T) {
	for _, scenario := range []string{"owner", "revision", "repository", "platform", "external-context", "dynamic-env", "outside-local-feature"} {
		t.Run(scenario, func(t *testing.T) {
			assignment, commit := prebuildRepository(t)
			request := PrebuildRequest{Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}
			switch scenario {
			case "owner":
				assignment.RepositoryIdentity = "other-project"
			case "revision":
				request.Commit = "main"
			case "repository":
				request.ImageRepository = "registry.factory/prebuilds/other-project"
			case "platform":
				request.Platform = "linux/unknown"
			default:
				name, content := ".devcontainer/Dockerfile", "FROM node:latest\n"
				if scenario == "external-context" {
					name, content = ".devcontainer/devcontainer.json", `{"build":{"dockerfile":"Dockerfile","context":"../../.."}}`
				}
				if scenario == "dynamic-env" {
					name, content = ".devcontainer/devcontainer.json", `{"image":"${localEnv:FACTORY_PROVIDER_KEY}"}`
				}
				if scenario == "mutable-feature" {
					name, content = ".devcontainer/devcontainer.json", `{"image":"node@sha256:`+strings.Repeat("a", 64)+`","features":{"ghcr.io/devcontainers/features/node:1":{}}}`
				}
				if scenario == "outside-local-feature" {
					name, content = ".devcontainer/devcontainer.json", `{"image":"node@sha256:`+strings.Repeat("a", 64)+`","features":{"../outside-feature":{}}}`
					if err := os.Mkdir(filepath.Join(assignment.WorkspaceFolder, "outside-feature"), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "outside-feature", "devcontainer-feature.json"), []byte(`{"id":"outside"}`), 0644); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, name), []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
				for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", scenario}} {
					if out, err := exec.Command("git", append([]string{"-C", assignment.WorkspaceFolder}, args...)...).CombinedOutput(); err != nil {
						t.Fatalf("fixture: %s %v", out, err)
					}
				}
				out, _ := exec.Command("git", "-C", assignment.WorkspaceFolder, "rev-parse", "HEAD").Output()
				request.Commit = strings.TrimSpace(string(out))
			}
			if _, _, err := prepareFixturePrebuildInput(context.Background(), assignment, request); err == nil {
				t.Fatalf("accepted %s", scenario)
			} else if scenario == "outside-local-feature" && !strings.Contains(err.Error(), "local Features inside") {
				t.Fatalf("did not reject the actual pinned-CLI local Feature path: %v", err)
			}
		})
	}
}

func TestPrebuildPersistsBeforeBuildAndRecoversPushWithoutRebuild(t *testing.T) {
	assignment, commit := prebuildRepository(t)
	request := PrebuildRequest{Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}
	calls, failPush := 0, true
	var publicationTag string
	build := func(ctx context.Context, operation prebuildOperation, snapshot string) (string, error) {
		calls++
		encoded, err := os.ReadFile(filepath.Join(operation.Directory, "intent.json"))
		if err != nil {
			t.Fatal("external build preceded intent")
		}
		var intent prebuildIntent
		if json.Unmarshal(encoded, &intent) != nil || intent.Identity != operation.Identity {
			t.Fatal("build intent differs")
		}
		if strings.HasPrefix(snapshot, assignment.WorkspaceFolder+string(os.PathSeparator)) {
			t.Fatal("build ran on canonical checkout")
		}
		return "sha256:" + strings.Repeat("b", 64), nil
	}
	push := func(ctx context.Context, operation prebuildOperation, imageID string) (string, error) {
		if publicationTag == "" {
			publicationTag = operation.Tag
		} else if publicationTag != operation.Tag {
			t.Fatal("recovery changed publication identity")
		}
		if failPush {
			return "", context.DeadlineExceeded
		}
		return request.ImageRepository + "@sha256:" + strings.Repeat("c", 64), nil
	}
	if _, err := producePrebuildWith(context.Background(), assignment, request, build, push, fixturePrebuildConfiguration); err == nil {
		t.Fatal("lost push acknowledgement reported success")
	}
	failPush = false
	assignment.RuntimeAttemptID = "new-compute-attempt-same-durable-workspace"
	result, err := producePrebuildWith(context.Background(), assignment, request, build, push, fixturePrebuildConfiguration)
	if err != nil || calls != 1 || result.Image != request.ImageRepository+"@sha256:"+strings.Repeat("c", 64) {
		t.Fatalf("recovery rebuilt or lost exact image: %+v %v, calls=%d", result, err, calls)
	}
	if _, err := producePrebuildWith(context.Background(), assignment, request, build, push, fixturePrebuildConfiguration); err != nil || calls != 1 {
		t.Fatal("completed replay rebuilt artifact")
	}
}

func TestPrebuildEnvironmentHasNoReusableCapabilities(t *testing.T) {
	t.Setenv("FACTORY_PROVIDER_KEY", "provider-secret")
	t.Setenv("GIT_ASKPASS", "malicious")
	t.Setenv("DOCKER_HOST", "tcp://node-docker:2375")
	joined := strings.Join(prebuildEnvironment("/private/prebuild/home"), "\n")
	for _, secret := range []string{"provider-secret", "malicious", "node-docker"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("inherited %s", secret)
		}
	}
	if !strings.Contains(joined, "DOCKER_HOST=unix:///var/run/docker.sock") {
		t.Fatal("prebuild did not bind its private daemon")
	}
}

func TestPrebuildSnapshotFromDevelopmentUserCheckout(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the real Parent-root / development-UID boundary")
	}
	assignment, commit := prebuildRepository(t)
	if err := filepath.WalkDir(assignment.WorkspaceFolder, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	_, _, err := prepareFixturePrebuildInput(context.Background(), assignment, PrebuildRequest{Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"})
	if err != nil {
		t.Fatalf("cannot snapshot the assigned development-user checkout: %v", err)
	}
}

func TestPrebuildInterruptedSnapshotCleanupChecksExactOwner(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "snapshot-owned")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	owner := prebuildSnapshotOwner{"project-one", strings.Repeat("a", 40)}
	encoded, _ := json.Marshal(owner)
	if err := os.WriteFile(filepath.Join(directory, "owner.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeInterruptedPrebuildSnapshots(root, "other-project"); err == nil {
		t.Fatal("deleted a foreign interrupted snapshot")
	}
	if _, err := os.Stat(directory); err != nil {
		t.Fatal("changed unconfirmed snapshot data")
	}
	if err := removeInterruptedPrebuildSnapshots(root, "project-one"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("owned interrupted snapshot remained")
	}
}

func TestProjectPrebuildRecoversCompletedLocalImageBeforeCLIBuild(t *testing.T) {
	directory := t.TempDir()
	operation := prebuildOperation{Identity: strings.Repeat("a", 64), Directory: directory, Tag: "registry.factory/prebuilds/project-one:factory-prebuild-test", Input: prebuildInput{Platform: "linux/arm64"}}
	image := prebuildImage{ID: "sha256:" + strings.Repeat("b", 64), OS: "linux", Architecture: "arm64"}
	image.Config.Labels = map[string]string{prebuildLabel: operation.Identity}
	encoded, _ := json.Marshal([]prebuildImage{image})
	log := filepath.Join(directory, "commands")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + log + "'\nif [ \"$1 $2\" = 'image inspect' ]; then printf '%s' '" + string(encoded) + "'; else echo private-registry-secret >&2;exit 1;fi\n"
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	id, err := buildProjectPrebuild(context.Background(), operation, "unused-snapshot")
	if err != nil || id != image.ID {
		t.Fatalf("did not recover produced image: %s %v", id, err)
	}
	if _, err := pushProjectPrebuild(context.Background(), operation, "sha256:"+strings.Repeat("c", 64)); err == nil {
		t.Fatal("published a moved tag")
	}
	commands, _ := os.ReadFile(log)
	if strings.Contains(string(commands), "push ") || strings.Contains(string(commands), "build ") {
		t.Fatal("replayed external create or published an unowned artifact")
	}
}

func TestProjectPrebuildRecoversPublishedArtifactAfterPrivateCacheEviction(t *testing.T) {
	directory := t.TempDir()
	repository := "registry.factory/prebuilds/project-one"
	operation := prebuildOperation{Identity: strings.Repeat("a", 64), Directory: directory, Tag: repository + ":factory-prebuild-test", Input: prebuildInput{Platform: "linux/arm64", ImageRepository: repository}}
	image := prebuildImage{ID: "sha256:" + strings.Repeat("b", 64), OS: "linux", Architecture: "arm64", RepoDigests: []string{repository + "@sha256:" + strings.Repeat("c", 64)}}
	image.Config.Labels = map[string]string{prebuildLabel: operation.Identity}
	encoded, _ := json.Marshal([]prebuildImage{image})
	log := filepath.Join(directory, "commands")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + log + "'\ncase \"$1 $2\" in 'image inspect') [ -f '" + log + ".pulled' ] || exit 1;printf '%s' '" + string(encoded) + "';; pull*) touch '" + log + ".pulled';; push*) exit 0;; *) exit 1;;esac\n"
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	digest, err := pushProjectPrebuild(context.Background(), operation, image.ID)
	if err != nil || digest != image.RepoDigests[0] {
		t.Fatalf("could not recover the exact published artifact: %s %v", digest, err)
	}
	commands, _ := os.ReadFile(log)
	if strings.Index(string(commands), "pull ") > strings.Index(string(commands), "push ") {
		t.Fatal("published before recovering the recorded artifact")
	}
}

func TestPrebuildDockerfileOwnershipMetadataCoversEachSelectableStage(t *testing.T) {
	identity := strings.Repeat("a", 64)
	source := "# syntax=docker/dockerfile@sha256:" + strings.Repeat("b", 64) + "\nFROM node@sha256:" + strings.Repeat("c", 64) + " AS seed\nRUN echo immutable\nFROM seed AS final\nRUN echo final\n"
	labeled := prebuildLabeledDockerfile(source, identity)
	marker := "LABEL " + prebuildLabel + "=" + identity + "\n"
	if strings.Count(labeled, marker) != 2 || !strings.Contains(labeled, "RUN echo immutable\n"+marker+"FROM seed AS final") || !strings.HasSuffix(labeled, marker) {
		t.Fatalf("intermediate or final stage lost its ownership metadata: %s", labeled)
	}
	if !strings.HasPrefix(labeled, "# syntax=") {
		t.Fatal("changed Dockerfile parser directive position")
	}
}

func TestPrebuildTaggedJSONCUsesUpstreamResolvedDocumentAndKeepsCanonicalRecipe(t *testing.T) {
	assignment, _ := prebuildRepository(t)
	path := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	source := "{ // ordinary authored recipe\n\"image\":\"node:24\",\"postCreateCommand\":\"node -v\",\n}\n"
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "tagged JSONC"}} {
		if err := exec.Command("git", append([]string{"-C", assignment.WorkspaceFolder}, args...)...).Run(); err != nil {
			t.Fatal(err)
		}
	}
	commit, err := prebuildGit(context.Background(), assignment.WorkspaceFolder, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	digest := "docker.io/library/node@sha256:" + strings.Repeat("d", 64)
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\ncase \"$1 $2\" in 'image inspect') printf '%s' '[\""+digest+"\"]';; pull*) exit 0;; *) exit 1;;esac\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	read := func(context.Context, string, string) (prebuildConfiguration, error) {
		return prebuildConfiguration{Image: "node:24", Document: json.RawMessage(`{"image":"node:24","postCreateCommand":"node -v"}`)}, nil
	}
	input, snapshot, err := preparePrebuildInputWith(context.Background(), assignment, PrebuildRequest{Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}, read)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	if len(input.ImmutableInputs) != 1 || input.ImmutableInputs[0] != digest {
		t.Fatal("tag not bound to resolved digest")
	}
	resolved, _ := os.ReadFile(filepath.Join(snapshot, assignment.DevcontainerPath))
	if !strings.Contains(string(resolved), digest) || !strings.Contains(string(resolved), "node -v") {
		t.Fatal("resolved recipe lost image or hook")
	}
	canonical, _ := os.ReadFile(path)
	if string(canonical) != source {
		t.Fatal("rewrote authored recipe")
	}
}

func TestPrebuildComposeFallbackNeverCreatesAnArtifact(t *testing.T) {
	assignment, commit := prebuildRepository(t)
	builds := 0
	read := func(context.Context, string, string) (prebuildConfiguration, error) {
		return prebuildConfiguration{DockerComposeFile: []string{"compose.yaml"}}, nil
	}
	build := func(context.Context, prebuildOperation, string) (string, error) { builds++; return "", nil }
	push := func(context.Context, prebuildOperation, string) (string, error) {
		t.Fatal("published unsupported recipe")
		return "", nil
	}
	_, err := producePrebuildWith(context.Background(), assignment, PrebuildRequest{Commit: commit, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}, build, push, read)
	if err == nil || builds != 0 {
		t.Fatal("Compose did not retain normal-start fallback")
	}
}
