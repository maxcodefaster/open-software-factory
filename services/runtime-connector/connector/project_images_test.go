package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func projectImage(letter string) string {
	return "registry.factory/project@sha256:" + strings.Repeat(letter, 64)
}

func TestProjectImageIdentityKeepsRepositoryAndDigestWhileNormalizingTags(t *testing.T) {
	digest := "@sha256:" + strings.Repeat("a", 64)
	want := "docker.io/library/node" + digest
	for _, value := range []string{"node" + digest, "docker.io/library/node:24" + digest, "index.docker.io/node" + digest} {
		key, err := projectImageKey(value)
		if err != nil || key != want {
			t.Fatalf("did not normalize Docker identity %s: %s, %v", value, key, err)
		}
	}
	for _, value := range []string{"node:latest", "sha256:" + strings.Repeat("a", 64), "https://docker.io/node" + digest} {
		if _, err := projectImageKey(value); err == nil {
			t.Fatalf("accepted a mutable or non-registry reference: %s", value)
		}
	}
	for _, value := range []string{"registry.factory/node" + digest, "docker.io/library/other" + digest, "docker.io/library/node@sha256:" + strings.Repeat("b", 64)} {
		key, err := projectImageKey(value)
		if err != nil || key == want {
			t.Fatalf("confused distinct repository/digest inputs: %s, %v", key, err)
		}
	}
}

func TestProjectImagePreparationBoundsAndDeduplicatesBeforeDownloads(t *testing.T) {
	for _, references := range [][]string{
		{"sha256:" + strings.Repeat("a", 64)},
		{projectImage("a"), "https://registry.factory/project"},
		{projectImage("a"), projectImage("b"), projectImage("c"), projectImage("d"), projectImage("e"), projectImage("f"), projectImage("0"), projectImage("1"), projectImage("2")},
	} {
		calls := 0
		err := prepareProjectImagesWith(context.Background(), references, func(context.Context, string) error { calls++; return nil })
		if err == nil || calls != 0 {
			t.Fatalf("invalid images reached Docker: %v, %d", err, calls)
		}
	}
	var calls atomic.Int32
	if err := prepareProjectImagesWith(context.Background(), []string{projectImage("a"), projectImage("a")}, func(context.Context, string) error { calls.Add(1); return nil }); err != nil || calls.Load() != 1 {
		t.Fatalf("same image downloaded repeatedly: %v, %d", err, calls.Load())
	}
}

func TestProjectImagePreparationUsesTwoWorkersAndJoinsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{}, 8)
	var active atomic.Int32
	var maximum atomic.Int32
	var calls atomic.Int32
	result := make(chan error, 1)
	go func() {
		result <- prepareProjectImagesWith(ctx, []string{projectImage("a"), projectImage("b"), projectImage("c"), projectImage("d")}, func(ctx context.Context, reference string) error {
			calls.Add(1)
			now := active.Add(1)
			for prior := maximum.Load(); now > prior && !maximum.CompareAndSwap(prior, now); prior = maximum.Load() {
			}
			defer active.Add(-1)
			started <- struct{}{}
			<-ctx.Done()
			return errors.New("cancelled")
		})
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("Project downloads were serialized")
		}
	}
	cancel()
	if err := <-result; err == nil || active.Load() != 0 || calls.Load() != 2 || maximum.Load() != 2 {
		t.Fatalf("workers escaped Stop or their concurrency bound: %v, active=%d calls=%d max=%d", err, active.Load(), calls.Load(), maximum.Load())
	}
	if err := prepareProjectImagesWith(ctx, []string{projectImage("a")}, func(context.Context, string) error { t.Fatal("download after Stop"); return nil }); err == nil {
		t.Fatal("accepted cancelled preparation")
	}
}

func TestProjectImageAcquisitionConfirmsDigestAndKeepsRegistryOutputPrivate(t *testing.T) {
	for _, scenario := range []string{"cached", "cold", "wrong-digest", "wrong-repository", "pull-failed", "unconfirmed", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			directory := t.TempDir()
			logPath := filepath.Join(directory, "commands")
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_IMAGE_LOG"
case "$1 $2" in
  "image inspect")
    if [ "$FACTORY_IMAGE_CASE" = wrong-digest ]; then printf '["registry.factory/project@sha256:wrong"]'; exit 0; fi
    if [ "$FACTORY_IMAGE_CASE" = wrong-repository ]; then printf '["registry.factory/other@sha256:%s"]' "$FACTORY_IMAGE_SHA"; exit 0; fi
    if [ "$FACTORY_IMAGE_CASE" = cached ] || [ -f "$FACTORY_IMAGE_LOG.pulled" ]; then printf '["%s"]' "$FACTORY_IMAGE_REFERENCE"; exit 0; fi
    exit 1 ;;
  "pull "*)
    if [ "$FACTORY_IMAGE_CASE" = pull-failed ]; then echo secret-registry-token >&2; exit 1; fi
    if [ "$FACTORY_IMAGE_CASE" != unconfirmed ]; then touch "$FACTORY_IMAGE_LOG.pulled"; fi ;;
  *) exit 1 ;;
esac
`
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_IMAGE_LOG", logPath)
			t.Setenv("FACTORY_IMAGE_CASE", scenario)
			t.Setenv("FACTORY_IMAGE_REFERENCE", projectImage("a"))
			t.Setenv("FACTORY_IMAGE_SHA", strings.Repeat("a", 64))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			}
			err := prepareProjectImages(ctx, []string{projectImage("a")})
			if (err != nil) != (scenario != "cold" && scenario != "cached") {
				t.Fatalf("image acquisition result: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "secret-registry-token") {
				t.Fatal("raw registry output escaped")
			}
			commands, _ := os.ReadFile(logPath)
			if scenario == "cached" && strings.Contains(string(commands), "pull ") {
				t.Fatalf("downloaded an already confirmed digest: %s", commands)
			}
			if scenario == "cold" && strings.Count(string(commands), "image inspect") != 2 {
				t.Fatalf("did not confirm image after pulling: %s", commands)
			}
		})
	}
}

func TestProjectImageAcquisitionMatchesDockersCanonicalTaggedDigest(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "commands")
	// Docker removes a tag and normalizes docker.io/library to the familiar name
	// in RepoDigests, even when inspect receives a tag plus immutable digest.
	reference := "docker.io/library/node:24.16.0-bookworm-slim@sha256:" + strings.Repeat("a", 64)
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_IMAGE_LOG"
if [ "$1 $2" = "image inspect" ]; then printf '["node@sha256:%s"]' "$FACTORY_IMAGE_SHA"; else exit 1; fi
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_IMAGE_LOG", logPath)
	t.Setenv("FACTORY_IMAGE_SHA", strings.Repeat("a", 64))
	if err := prepareProjectImages(context.Background(), []string{reference}); err != nil {
		t.Fatalf("rejected the actual Docker RepoDigests representation: %v", err)
	}
	commands, _ := os.ReadFile(logPath)
	if strings.Contains(string(commands), "pull ") {
		t.Fatalf("downloaded an already cached tagged digest: %s", commands)
	}
}

func TestDevcontainerImagePreparationSelectsOnlyStartedServicesAndDependencies(t *testing.T) {
	directory := t.TempDir()
	configuration := map[string]any{
		"configuration":       map[string]any{"dockerComposeFile": "compose.yaml", "service": "app", "runServices": []string{"app"}},
		"mergedConfiguration": map[string]any{},
	}
	compose := map[string]any{"services": map[string]any{
		"app":        map[string]any{"image": projectImage("a"), "cap_drop": []string{"ALL"}, "depends_on": map[string]any{"database": map[string]any{"condition": "service_healthy"}}},
		"database":   map[string]any{"image": projectImage("b")},
		"unused":     map[string]any{"image": projectImage("c"), "profiles": []string{"optional"}},
		"unselected": map[string]any{"image": projectImage("d")},
	}}
	for executable, value := range map[string]any{"devcontainer": configuration, "docker": compose} {
		encoded, _ := json.Marshal(value)
		script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '%s'\n", encoded)
		if err := os.WriteFile(filepath.Join(directory, executable), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	images, err := validateDevcontainer(context.Background(), Assignment{WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json"})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, image := range images {
		seen[image] = true
	}
	if len(seen) != 2 || !seen[projectImage("a")] || !seen[projectImage("b")] {
		t.Fatalf("prepared unused Project services or missed a required dependency: %v", images)
	}
}

func TestDevcontainerConfigurationRequiresCLIResult(t *testing.T) {
	for _, output := range []string{`{}`, `{"configuration":{"image":"ignored"}}`, `{"mergedConfiguration":{}}`} {
		t.Run(output, func(t *testing.T) {
			directory := t.TempDir()
			script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '%s'\n", output)
			if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			if _, err := validateDevcontainer(context.Background(), Assignment{WorkspaceFolder: directory}); err == nil {
				t.Fatal("accepted an incomplete CLI configuration result")
			}
		})
	}
}

func TestConfigurationDiscoveryDoesNotReadRemoteMetadataAndMergedGuardsReReadInputs(t *testing.T) {
	directory := t.TempDir()
	configuration := filepath.Join(directory, "configuration")
	commands := filepath.Join(directory, "commands")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_CONFIGURATION_COMMANDS"
case " $* " in
  *" --include-merged-configuration "*)
    if [ ! -f "$FACTORY_CONFIGURATION_CHANGED" ]; then exit 1; fi
    printf '{"configuration":{},"mergedConfiguration":{"privileged":true}}\n';;
  *) printf '{"configuration":{"image":"registry.invalid/project@sha256:` + strings.Repeat("a", 64) + `"}}\n';;
esac
`
	if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_CONFIGURATION_COMMANDS", commands)
	t.Setenv("FACTORY_CONFIGURATION_CHANGED", configuration)
	assignment := Assignment{WorkspaceFolder: directory, RuntimeAttemptID: "exact-attempt", Generation: 2}
	images, err := validateDevcontainerConfiguration(context.Background(), assignment, false)
	if err != nil || len(images) != 1 || images[0] != "registry.invalid/project@sha256:"+strings.Repeat("a", 64) {
		t.Fatalf("discovery fetched metadata or failed to select immutable inputs: %v %v", images, err)
	}
	if err := os.WriteFile(configuration, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateDevcontainer(context.Background(), assignment); err == nil || !strings.Contains(err.Error(), "privileged") {
		t.Fatalf("merged validation reused obsolete configuration: %v", err)
	}
	log, _ := os.ReadFile(commands)
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) != 2 || strings.Contains(lines[0], "--include-merged-configuration") || !strings.Contains(lines[1], "--include-merged-configuration") {
		t.Fatalf("discovery and merged-validation command order is wrong: %s", log)
	}
	for _, line := range lines {
		if !strings.Contains(line, "--id-label factory.dev/runtime-attempt=exact-attempt") || !strings.Contains(line, "--id-label factory.dev/runtime-generation=2") {
			t.Fatalf("configuration inspected a former attempt: %s", line)
		}
	}
}

func TestProjectImagePreparationRejectsChangedInputsBeforeContainerStart(t *testing.T) {
	digest := "@sha256:" + strings.Repeat("a", 64)
	prepared := []string{"node:24" + digest, projectImage("b")}
	if err := requirePreparedProjectImages(prepared, []string{projectImage("b"), "docker.io/library/node" + digest, projectImage("b")}); err != nil {
		t.Fatalf("rejected the same exact image inputs: %v", err)
	}
	for _, current := range [][]string{
		{projectImage("b")},
		{"node" + digest, projectImage("c")},
		{"other" + digest, projectImage("b")},
		{"node:latest", projectImage("b")},
	} {
		if err := requirePreparedProjectImages(prepared, current); err == nil {
			t.Fatalf("changed inputs reused previous acquisition: %v", current)
		}
	}
}

func TestDevcontainerPreparationFencesImageChangesDuringAcquisition(t *testing.T) {
	directory := t.TempDir()
	cli := `#!/bin/sh
case " $* " in
  *" --include-merged-configuration "*)
    if [ ! -f "$FACTORY_CONFIGURATION_CHANGED" ]; then exit 1; fi
    printf '{"configuration":{"image":"registry.factory/project@sha256:` + strings.Repeat("b", 64) + `"},"mergedConfiguration":{}}\n';;
  *) printf '{"configuration":{"image":"registry.factory/project@sha256:` + strings.Repeat("a", 64) + `"}}\n';;
esac
`
	docker := `#!/bin/sh
case "$1 $2" in
  "image inspect")
    if [ ! -f "$FACTORY_CONFIGURATION_CHANGED" ]; then exit 1; fi
    printf '["registry.factory/project@sha256:` + strings.Repeat("a", 64) + `"]\n';;
  "pull "*) touch "$FACTORY_CONFIGURATION_CHANGED";;
  *) exit 1;;
esac
`
	for name, script := range map[string]string{"devcontainer": cli, "docker": docker} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_CONFIGURATION_CHANGED", filepath.Join(directory, "changed"))
	err := prepareDevcontainerProject(context.Background(), Assignment{WorkspaceFolder: directory, RuntimeAttemptID: "exact-attempt", Generation: 2})
	if err == nil || !strings.Contains(err.Error(), "inputs changed") {
		t.Fatalf("container preparation accepted unacquired changed inputs: %v", err)
	}
}
