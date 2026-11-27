package connector

import (
	"os"
	"path/filepath"
	"testing"
)

func cleanupDockerFixture(t *testing.T, script string) string {
	t.Helper()
	directory := t.TempDir()
	log := filepath.Join(directory, "commands")
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FACTORY_CLEANUP_LOG\"\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_CLEANUP_LOG", log)
	return log
}
