package connector

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrebuildLostBuildReplyRequiresPositiveImageObservation(t *testing.T) {
	for _, completed := range []bool{false, true} {
		t.Run(fmt.Sprint(completed), func(t *testing.T) {
			directory := t.TempDir()
			assignment, commit := prebuildRepository(t)
			ctx := fixturePrebuildToolsContext(t.Context(), assignment)
			input, snapshot, err := prepareFixturePrebuildInput(ctx, assignment, PrebuildRequest{
				Commit: commit, Platform: "linux/amd64", ImageRepository: "registry.factory/prebuilds/project-one",
			})
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(filepath.Dir(snapshot))
			calls := filepath.Join(directory, "cli-calls")
			identity := prebuildIdentity(input)
			imageID := "sha256:" + strings.Repeat("b", 64)
			docker := "#!/bin/sh\nexit 1\n"
			if completed {
				docker = fmt.Sprintf("#!/bin/sh\ntest -f %q || exit 1\nprintf '%%s\\n' '%s'\n", calls,
					`[{"Id":"`+imageID+`","Os":"linux","Architecture":"amd64","Config":{"Labels":{"factory.dev/prebuild-input":"`+identity+`"}}}]`)
			}
			cli := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = --version ]; then printf '0.89.0\\n'; exit 0; fi\nprintf 'dispatched\\n' >> %q\nexit 1\n", calls)
			for name, content := range map[string]string{"docker": docker, "devcontainer": cli} {
				if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			operation := prebuildOperation{Identity: identity, Directory: directory,
				Tag:   "registry.factory/prebuilds/project-one:owned-dispatch",
				Input: input}
			if _, err := buildProjectPrebuild(ctx, operation, snapshot); err == nil ||
				!strings.Contains(err.Error(), "Project prebuild failed") {
				t.Fatalf("lost CLI result did not reach the original build dispatch: %v", err)
			}
			image, err := buildProjectPrebuild(ctx, operation, snapshot)
			if completed {
				if err != nil || image != imageID {
					t.Fatalf("positive original image observation was not recovered: %s: %v", image, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "original build was not repeated") {
				t.Fatalf("uncertain build was not retained: %v", err)
			}
			stored, err := os.ReadFile(calls)
			if err != nil || string(stored) != "dispatched\n" {
				t.Fatalf("CLI build was repeated: %q: %v", stored, err)
			}
		})
	}
}

func TestPrebuildDispatchRejectsMissingOrChangedPublicToolsIdentity(t *testing.T) {
	for _, digest := range []string{"", strings.Repeat("c", 64)} {
		name := "changed"
		if digest == "" {
			name = "missing"
		}
		t.Run(name, func(t *testing.T) {
			assignment, commit := prebuildRepository(t)
			ctx := fixturePrebuildToolsContext(t.Context(), assignment)
			input, snapshot, err := prepareFixturePrebuildInput(ctx, assignment, PrebuildRequest{
				Commit: commit, Platform: "linux/amd64", ImageRepository: "registry.factory/prebuilds/project-one",
			})
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(filepath.Dir(snapshot))
			input.OpenCodeArtifactsSHA256 = digest
			directory := t.TempDir()
			calls := filepath.Join(directory, "cli-calls")
			cli := fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = --version ]; then printf '0.89.0\\n'; exit 0; fi\nprintf 'dispatched\\n' >> %q\n", calls)
			for name, content := range map[string]string{"docker": "#!/bin/sh\nexit 1\n", "devcontainer": cli} {
				if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			operation := prebuildOperation{
				Identity: prebuildIdentity(input), Directory: directory,
				Tag: "registry.factory/prebuilds/project-one:owned-dispatch", Input: input,
			}
			if _, err := buildProjectPrebuild(ctx, operation, snapshot); err == nil ||
				!strings.Contains(err.Error(), "Prepared OpenCode payload differs from its frozen build input") {
				t.Fatalf("invalid public tool identity did not fail closed before dispatch: %v", err)
			}
			for _, path := range []string{calls, filepath.Join(directory, "build-dispatched"),
				filepath.Join(snapshot, ".devcontainer", preparedOpenCodeFeature)} {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatalf("invalid tool identity reached dispatch or Feature staging: %s: %v", path, err)
				}
			}
		})
	}
}
