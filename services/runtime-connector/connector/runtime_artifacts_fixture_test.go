package connector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type openCodeArtifactsRootKey struct{}

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
		file := filepath.Join(root, name)
		if err := os.WriteFile(file, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(file, mode); err != nil {
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
