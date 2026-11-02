package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Explicit offline component proof. The caller owns an isolated, resource-bounded
// private Docker daemon. This does not claim Factorybox or installation acceptance.
func TestPrebuildComposeNative(t *testing.T) {
	if os.Getenv("FACTORY_COMPOSE_PREBUILD_NATIVE") != "1" {
		t.Skip("explicit native Compose prebuild component proof")
	}
	ctx := context.Background()
	kind := os.Getenv("FACTORY_COMPOSE_PROOF_KIND")
	if kind == "" {
		kind = "build"
	}
	if kind != "build" && kind != "image-only" {
		t.Fatal("unknown native Compose proof recipe")
	}
	platform := "linux/" + runtime.GOARCH
	if runtime.GOOS != "linux" || platform != os.Getenv("FACTORY_COMPOSE_PROOF_PLATFORM") {
		t.Fatal("proof is not running on its admitted native architecture")
	}
	cli, err := exec.LookPath("devcontainer")
	if err != nil {
		t.Fatal(err)
	}
	wrappers := t.TempDir()
	wrapper := fmt.Sprintf(`#!/bin/sh
if [ "$1" = build ]; then
  %q "$@" >/tmp/owned-devcontainer-build.log 2>&1
  exit $?
fi
exec %q "$@"
`, cli, cli)
	if err := os.WriteFile(filepath.Join(wrappers, "devcontainer"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	dockerCLI, err := exec.LookPath("docker")
	if err != nil {
		t.Fatal(err)
	}
	dockerWrapper := fmt.Sprintf(`#!/bin/sh
if [ "$1" = builder ] && [ "$2" = prune ]; then printf 'trim\n' >>/tmp/owned-cache-trims; fi
exec %q "$@"
`, dockerCLI)
	if err := os.WriteFile(filepath.Join(wrappers, "docker"), []byte(dockerWrapper), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", wrappers+string(os.PathListSeparator)+os.Getenv("PATH"))
	command := func(name string, args ...string) string {
		t.Helper()
		output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("owned %s command failed: %s: %v", name, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	baseID, registryID := os.Getenv("FACTORY_COMPOSE_PROOF_NODE"), os.Getenv("FACTORY_COMPOSE_PROOF_REGISTRY")
	if !prebuildImageID.MatchString(baseID) || !prebuildImageID.MatchString(registryID) {
		t.Fatal("proof dependencies require exact local image IDs")
	}
	registry := command("docker", "run", "--detach", "--publish", "127.0.0.1:5000:5000", registryID)
	defer exec.Command("docker", "rm", "--force", "--volumes", registry).Run()
	client := &http.Client{Timeout: time.Second}
	for {
		response, err := client.Get("http://127.0.0.1:5000/v2/")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if command("docker", "inspect", "--format", "{{.State.Running}}", registry) != "true" {
			t.Fatal("owned Registry stopped before readiness")
		}
		time.Sleep(100 * time.Millisecond)
	}
	baseTag := "127.0.0.1:5000/fixture/node:owned"
	// Exporting one native platform can change a multi-platform index ID.
	// Compare actual filesystem/configuration content across this owned mirror,
	// while binding builds to the Registry's independently confirmed digest.
	basePayload := command("docker", "image", "inspect", "--format", "{{json .RootFS}} {{json .Config}} {{.Os}}/{{.Architecture}}", baseID)
	command("docker", "tag", baseID, baseTag)
	command("docker", "push", baseTag)
	manifestRequest, err := http.NewRequest(http.MethodHead, "http://127.0.0.1:5000/v2/fixture/node/manifests/owned", nil)
	if err != nil {
		t.Fatal(err)
	}
	manifestRequest.Header.Set("Accept", "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json")
	response, err := client.Do(manifestRequest)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	digest := response.Header.Get("Docker-Content-Digest")
	if response.StatusCode != http.StatusOK || !prebuildImageID.MatchString(digest) {
		t.Fatal("owned Registry did not confirm its actual base manifest")
	}
	base := "127.0.0.1:5000/fixture/node@" + digest
	command("docker", "pull", base)
	if command("docker", "image", "inspect", "--format", "{{json .RootFS}} {{json .Config}} {{.Os}}/{{.Architecture}}", base) != basePayload {
		t.Fatal("owned base publication changed the original native payload")
	}
	root := filepath.Join(t.TempDir(), "project")
	files := map[string]string{
		".devcontainer/devcontainer.json":                 `{"dockerComposeFile":"compose.json","service":"workspace","workspaceFolder":"/workspace/project","remoteUser":"root","features":{"./feature":{}},"onCreateCommand":["node","-e","require('fs').cpSync('/opt/project-seed','/workspace/project/dependency',{recursive:true})"],"postCreateCommand":["node","-e","require('fs').writeFileSync('/workspace/project/project-hook','required project hook')"]}`,
		".devcontainer/compose.json":                      `{"name":"owned_compose_project","services":{"workspace":{"build":{"context":"..","dockerfile":".devcontainer/Dockerfile"},"volumes":["..:/workspace/project"],"cap_drop":["ALL"],"command":["sleep","infinity"]},"support":{"image":"` + base + `","command":["sleep","infinity"]}}}`,
		".devcontainer/Dockerfile":                        "FROM " + base + "\nCOPY seed /opt/project-seed\nRUN cd /opt/project-seed && npm ci --offline --ignore-scripts --no-audit --no-fund\n",
		".devcontainer/feature/devcontainer-feature.json": `{"id":"fixture","version":"1.0.0","name":"Owned feature","postCreateCommand":["node","-e","require('fs').writeFileSync('/workspace/project/feature-hook','required Feature hook')"]}`,
		".devcontainer/feature/install.sh":                "#!/bin/sh\nset -eu\nprintf 'prepared toolchain' > /opt/prebuilt-feature\n",
		"seed/package.json":                               `{"name":"seed","version":"1.0.0","dependencies":{"local-dependency":"file:./dependency"}}`,
		"seed/dependency/package.json":                    `{"name":"local-dependency","version":"1.0.0","main":"index.js"}`,
		"seed/dependency/index.js":                        `module.exports="exact offline dependency";`,
		"seed/package-lock.json":                          `{"name":"seed","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"seed","version":"1.0.0","dependencies":{"local-dependency":"file:./dependency"}},"dependency":{"name":"local-dependency","version":"1.0.0"},"node_modules/local-dependency":{"resolved":"dependency","link":true}}}`,
	}
	if kind == "image-only" {
		var config map[string]any
		json.Unmarshal([]byte(files[".devcontainer/devcontainer.json"]), &config)
		config["onCreateCommand"] = []string{"node", "-e", `require("fs").mkdirSync("/workspace/project/dependency",{recursive:true})`}
		encoded, _ := json.Marshal(config)
		files[".devcontainer/devcontainer.json"] = string(encoded)
		var compose map[string]any
		json.Unmarshal([]byte(files[".devcontainer/compose.json"]), &compose)
		primary := compose["services"].(map[string]any)["workspace"].(map[string]any)
		delete(primary, "build")
		primary["image"] = base
		encoded, _ = json.Marshal(compose)
		files[".devcontainer/compose.json"] = string(encoded)
	}
	for path, content := range files {
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	command("git", "-C", root, "init", "--initial-branch=main")
	command("git", "-C", root, "config", "factory.repositoryIdentity", "owned-compose-project")
	command("git", "-C", root, "add", ".")
	command("git", "-C", root, "-c", "user.name=Owned fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "exact offline Compose recipe")
	commit := command("git", "-C", root, "rev-parse", "HEAD")
	assignment := Assignment{
		Version: 1, RuntimeAttemptID: "owned-compose-producer", Generation: 1,
		RepositoryIdentity: "owned-compose-project", WorkspaceFolder: root, RemoteWorkspaceFolder: "/workspace/project",
		Revision: commit, DevcontainerPath: ".devcontainer/devcontainer.json",
		ComposeProjectName: "owned_compose_project",
	}
	request := PrebuildRequest{Commit: commit, Platform: platform, ImageRepository: "127.0.0.1:5000/prebuilds/owned-compose-project"}
	initialTrims, _ := os.ReadFile("/tmp/owned-cache-trims")
	started := time.Now()
	result, err := ProducePrebuild(ctx, assignment, request)
	if err != nil {
		// This fixture has synthetic source, no credentials and no external
		// network. Keep its actual native failure instead of weakening a check.
		diagnostic, _ := os.ReadFile("/tmp/owned-devcontainer-build.log")
		if len(diagnostic) > 24*1024 {
			diagnostic = diagnostic[len(diagnostic)-24*1024:]
		}
		t.Log(string(diagnostic))
		t.Fatal(err)
	}
	first := time.Since(started)
	beforeReplay, err := os.ReadFile("/tmp/owned-cache-trims")
	if err != nil || strings.Count(string(beforeReplay), "trim\n") != strings.Count(string(initialTrims), "trim\n")+1 {
		t.Fatal("newly published image did not retain bounded private build-cache cleanup")
	}
	started = time.Now()
	replay, err := ProducePrebuild(ctx, assignment, request)
	if err != nil || replay != result {
		t.Fatalf("exact Compose replay changed or rebuilt its artifact: %+v: %v", replay, err)
	}
	replayed := time.Since(started)
	afterReplay, err := os.ReadFile("/tmp/owned-cache-trims")
	if err != nil || string(afterReplay) != string(beforeReplay) {
		t.Fatal("completed prebuild replay repeated synchronous build-cache pruning")
	}
	assignment.RuntimeAttemptID = "owned-compose-consumer"
	path, cleanup, err := preparePrebuildConsumer(ctx, assignment, result.Image)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	assignment.EffectiveConfiguration = path
	if _, err := validateDevcontainer(ctx, assignment); err != nil {
		t.Fatal(err)
	}
	started = time.Now()
	container, err := startDevcontainer(ctx, assignment)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := cleanupProject(parentState{
			RuntimeAttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation,
			ContainerID: container.ContainerID, ComposeProjectName: container.ComposeProjectName,
		}); err != nil {
			t.Error(err)
		}
	}()
	consumer := time.Since(started)
	observation := command("docker", "exec", container.ContainerID, "node", "-e",
		`const fs=require("fs"); const dependency=fs.existsSync("/opt/project-seed")?require("/workspace/project/dependency/node_modules/local-dependency"):"image-only"; const values={dependency,feature:fs.readFileSync("/opt/prebuilt-feature","utf8"),projectHook:fs.readFileSync("/workspace/project/project-hook","utf8"),featureHook:fs.readFileSync("/workspace/project/feature-hook","utf8")}; fs.writeFileSync("/workspace/project/dependency/manual","still writable"); process.stdout.write(JSON.stringify(values));`)
	dependency := "exact offline dependency"
	if kind == "image-only" {
		dependency = "image-only"
	}
	var values map[string]string
	if json.Unmarshal([]byte(observation), &values) != nil ||
		values["dependency"] != dependency || values["feature"] != "prepared toolchain" ||
		values["projectHook"] != "required project hook" || values["featureHook"] != "required Feature hook" {
		t.Fatalf("prepared Compose consumer lost dependencies or required hooks: %s", observation)
	}
	var selected map[string]any
	output := command("docker", "inspect", "--format", "{{json .Config}}", container.ContainerID)
	if json.Unmarshal([]byte(output), &selected) != nil || selected["Image"] != result.Image {
		t.Fatalf("Compose consumer did not use the exact prebuilt digest: %s", output)
	}
	summary := map[string]any{
		"nativeComponentProof": true, "nativeFactoryboxProof": false, "platform": platform,
		"primaryKind": kind, "preparedDependency": kind == "build",
		"image": result.Image, "firstBuildMS": first.Milliseconds(), "replayMS": replayed.Milliseconds(),
		"consumerStartMS": consumer.Milliseconds(), "requiredHooks": true, "writableDependency": true,
		"modelCalls": 0, "projectCredentials": false,
	}
	encoded, _ := json.Marshal(summary)
	if err := os.WriteFile("/tmp/compose-prebuild-result.json", encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("/tmp/compose-prebuild-result-"+kind+".json", encoded, 0600); err != nil {
		t.Fatal(err)
	}
	fmt.Println(string(encoded))
}
