package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixturePrebuildTools(t *testing.T, root string) {
	t.Helper()
	for _, directory := range []string{"server", "glibc", "musl"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range map[string]string{
		"server/server.mjs":     "export const shipped = true;\n",
		"server/input-stop.mjs": "export const stop = true;\n",
		"glibc/bun":             "owned glibc binary bytes\n",
		"musl/bun":              "owned musl binary bytes\n",
	} {
		mode := os.FileMode(0644)
		if strings.HasSuffix(name, "/bun") {
			mode = 0555
		}
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	manifest, err := OpenCodeArtifactsManifest(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), manifest, 0644); err != nil {
		t.Fatal(err)
	}
}

func fixturePrebuildToolsContext(ctx context.Context, assignment Assignment) context.Context {
	return context.WithValue(ctx, openCodeArtifactsRootKey{},
		filepath.Join(filepath.Dir(assignment.WorkspaceFolder), "opencode-tools"))
}

func TestPrebuildOpenCodeChangesIdentityWithoutCopyingDuringObservation(t *testing.T) {
	assignment, revision := prebuildRepository(t)
	ctx := fixturePrebuildToolsContext(t.Context(), assignment)
	request := PrebuildRequest{Commit: revision, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"}
	first, snapshot, err := preparePrebuildInputWith(ctx, assignment, request, fixturePrebuildConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	if len(first.OpenCodeArtifactsSHA256) != 64 {
		t.Fatal("prepared image has no complete tool identity")
	}
	if _, err := os.Stat(filepath.Join(snapshot, ".devcontainer", preparedOpenCodeFeature)); !os.IsNotExist(err) {
		t.Fatal("read-only recipe observation copied the tool payload")
	}
	root := openCodeArtifactsRoot(ctx)
	if err := os.WriteFile(filepath.Join(root, "server", "input-stop.mjs"), []byte("changed shipped stop worker\n"), 0644); err != nil {
		t.Fatal(err)
	}
	manifest, err := OpenCodeArtifactsManifest(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), manifest, 0644); err != nil {
		t.Fatal(err)
	}
	second, snapshot2, err := preparePrebuildInputWith(ctx, assignment, request, fixturePrebuildConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot2))
	if prebuildIdentity(first) == prebuildIdentity(second) {
		t.Fatal("prepared image ignored a changed shipped native worker")
	}
}

func TestPrebuildOpenCodeStagesOnlyPublicToolsWithoutChangingProjectHooksOrSource(t *testing.T) {
	assignment, revision := prebuildRepository(t)
	ctx := fixturePrebuildToolsContext(t.Context(), assignment)
	sourceConfig := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	before, err := os.ReadFile(sourceConfig)
	if err != nil {
		t.Fatal(err)
	}
	input, snapshot, err := preparePrebuildInputWith(ctx, assignment,
		PrebuildRequest{Commit: revision, Platform: "linux/arm64", ImageRepository: "registry.factory/prebuilds/project-one"},
		fixturePrebuildConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	root := openCodeArtifactsRoot(ctx)
	if err := os.WriteFile(filepath.Join(root, "private-model-env"), []byte("must not copy\n"), 0600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(snapshot, input.Configuration)
	var document map[string]json.RawMessage
	raw, _ := os.ReadFile(config)
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	document["postCreateCommand"] = json.RawMessage(`"authored setup"`)
	raw, _ = json.Marshal(document)
	if err := os.WriteFile(config, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := stagePrebuildOpenCode(ctx, prebuildOperation{Input: input}, snapshot); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(config)
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if string(document["postCreateCommand"]) != `"authored setup"` {
		t.Fatal("tool preparation changed an authored lifecycle hook")
	}
	var features map[string]json.RawMessage
	if err := json.Unmarshal(document["features"], &features); err != nil ||
		features["./feature"] == nil || features["./"+preparedOpenCodeFeature] == nil {
		t.Fatal("tool preparation replaced rather than merged Project Features")
	}
	if _, err := os.Stat(filepath.Join(snapshot, ".devcontainer", preparedOpenCodeFeature, "private-model-env")); !os.IsNotExist(err) {
		t.Fatal("prepared image included private installation state")
	}
	listing, err := ownedCommand(ctx, "tar", "-tf", filepath.Join(snapshot, ".devcontainer", preparedOpenCodeFeature, "payload.tar")).Output()
	if err != nil || strings.Contains(string(listing), "private-model-env") ||
		!strings.Contains(string(listing), "server/input-stop.mjs") ||
		!strings.Contains(string(listing), "musl/bun") || !strings.Contains(string(listing), "glibc/bun") {
		t.Fatal("prepared archive lost its exact public payload allowlist")
	}
	ignore, err := os.ReadFile(filepath.Join(input.buildContext, ".dockerignore"))
	if err != nil || !strings.Contains(string(ignore), "/.devcontainer/"+preparedOpenCodeFeature+"/") {
		t.Fatal("generated tool payload leaked into authored COPY contexts")
	}
	after, err := os.ReadFile(sourceConfig)
	if err != nil || string(after) != string(before) {
		t.Fatal("preparation edited canonical Project configuration")
	}
	if err := stagePrebuildOpenCode(ctx, prebuildOperation{Input: input}, snapshot); err == nil {
		t.Fatal("a second staging operation adopted an existing private Feature")
	}
}
