package trust

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeProjectTemplateFirstImportIntegrity(t *testing.T) {
	root := t.TempDir()
	path := ".factory/actor-template.json"
	content := []byte("{\"containers\":[]}\n")
	if err := os.Mkdir(filepath.Join(root, ".factory"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, filepath.FromSlash(path))
	if err := os.WriteFile(file, content, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	expected := ProjectTemplate{path, hex.EncodeToString(digest[:])}
	if err := VerifyProjectTemplate(root, path, &expected); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, append(content, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyProjectTemplate(root, path, &expected); err == nil {
		t.Fatal("a different saved byte sequence was admitted")
	}
	for _, invalid := range []ProjectTemplate{
		{"../escape", expected.SHA256}, {"/absolute", expected.SHA256},
		{".factory//template.json", expected.SHA256}, {`C:\escape`, expected.SHA256},
		{path, strings.ToUpper(expected.SHA256)}, {path, "unconfirmed"},
		{path, strings.Repeat("0", 62)}, {path, strings.Repeat("0", 66)},
	} {
		if err := VerifyProjectTemplate(root, path, &invalid); err == nil {
			t.Fatalf("invalid template identity accepted: %+v", invalid)
		}
	}
	if err := VerifyProjectTemplate(root, ".factory/another.json", &expected); err == nil {
		t.Fatal("another selected template path was admitted")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := VerifyProjectTemplate(root, path, &expected); err == nil {
		t.Fatal("a missing selected template was admitted")
	}
	for _, invalid := range [][]byte{make([]byte, (64<<10)+1), {0xff, 0xfe}} {
		if err := os.WriteFile(file, invalid, 0600); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(invalid)
		current := ProjectTemplate{path, hex.EncodeToString(hash[:])}
		if err := VerifyProjectTemplate(root, path, &current); err == nil {
			t.Fatal("oversized or invalid UTF-8 bytes were admitted")
		}
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, file); err != nil {
		t.Fatal(err)
	}
	if err := VerifyProjectTemplate(root, path, &expected); err == nil {
		t.Fatal("a symlink escaped the admitted Source file")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	if err := VerifyProjectTemplate(root, path, &expected); err == nil {
		t.Fatal("a directory was admitted as template bytes")
	}
}
