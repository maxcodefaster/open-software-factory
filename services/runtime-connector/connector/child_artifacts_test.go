package connector

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStageChildExecutableCopiesBytesWithoutChangingTheShippedFile(t *testing.T) {
	source := filepath.Join(t.TempDir(), "shipped-tool")
	content := []byte("#!/bin/sh\nprintf owned-child-tool\\n\n")
	if err := os.WriteFile(source, content, 0755); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(source)
	path, cleanup, err := stageChildExecutable(source)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	staged, err := os.ReadFile(path)
	info, statErr := os.Stat(path)
	after, _ := os.Stat(source)
	if err != nil || statErr != nil || string(staged) != string(content) || info.Mode().Perm() != 0555 || os.SameFile(before, info) || !os.SameFile(before, after) || after.Mode() != before.Mode() || !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("artifact staging changed the shipped file, bytes or executable mode")
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("private staged executable was not removed")
	}
	if _, _, err := stageChildExecutable(filepath.Dir(source)); err == nil {
		t.Fatal("directory accepted as shipped executable")
	}
}
