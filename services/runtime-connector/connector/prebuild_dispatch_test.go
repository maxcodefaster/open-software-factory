package connector

import (
	"context"
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
			snapshot := t.TempDir()
			calls := filepath.Join(directory, "cli-calls")
			identity := strings.Repeat("a", 64)
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
				Input: prebuildInput{Configuration: ".devcontainer/devcontainer.json", Platform: "linux/amd64"}}
			if _, err := buildProjectPrebuild(context.Background(), operation, snapshot); err == nil {
				t.Fatal("lost CLI result was reported as success")
			}
			image, err := buildProjectPrebuild(context.Background(), operation, snapshot)
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
