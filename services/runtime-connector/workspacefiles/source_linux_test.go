package workspacefiles

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

func testSource(t *testing.T) (*Source, string) {
	t.Helper()
	checkout := t.TempDir()
	source, err := Open(checkout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { source.Close() })
	return source, checkout
}

func TestSourceWithoutExecution(t *testing.T) {
	source, checkout := testSource(t)
	if err := os.WriteFile(filepath.Join(checkout, "app.ts"), []byte("original"), 0755); err != nil {
		t.Fatal(err)
	}
	read, err := source.Read("app.ts")
	if err != nil || string(read.Content) != "original" || read.Version == "" {
		t.Fatalf("real source read: %#v, %v", read, err)
	}
	saved, err := source.Write("app.ts", []byte("human edit"), read.Version)
	if err != nil || saved.Version == read.Version {
		t.Fatalf("save: %#v, %v", saved, err)
	}
	content, err := os.ReadFile(filepath.Join(checkout, "app.ts"))
	if err != nil || string(content) != "human edit" {
		t.Fatalf("canonical checkout did not receive edit: %q, %v", content, err)
	}
	info, err := os.Stat(filepath.Join(checkout, "app.ts"))
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("save changed executable mode: %v, %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "app.ts"), []byte("agent edit"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Write("app.ts", []byte("stale human edit"), saved.Version); !errors.Is(err, ErrConflict) {
		t.Fatalf("known stale write was not rejected: %v", err)
	}
	content, _ = os.ReadFile(filepath.Join(checkout, "app.ts"))
	if string(content) != "agent edit" {
		t.Fatalf("stale save replaced current source: %q", content)
	}
}

func TestSourceCreateAndConcurrentSaves(t *testing.T) {
	source, checkout := testSource(t)
	created, err := source.Write("new.txt", []byte("initial"), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Write("new.txt", []byte("blind overwrite"), ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("create overwrote existing file: %v", err)
	}
	var group sync.WaitGroup
	results := make(chan error, 2)
	for _, content := range []string{"first", "second"} {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := source.Write("new.txt", []byte(content), created.Version)
			results <- err
		}()
	}
	group.Wait()
	close(results)
	var conflicts, successes int
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if conflicts != 1 || successes != 1 {
		t.Fatalf("expected exactly one CAS winner: %d successes, %d conflicts", successes, conflicts)
	}
	entries, _ := os.ReadDir(checkout)
	if len(entries) != 1 {
		t.Fatalf("save leaked temporary source files: %v", entries)
	}
}

func TestSourceContainsPathsLinksAndSpecialFiles(t *testing.T) {
	source, checkout := testSource(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("not source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(checkout, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, ".git", "config"), []byte("private metadata"), 0600); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"escape": outside, "metadata": ".git"} {
		if err := os.Symlink(target, filepath.Join(checkout, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Mkfifo(filepath.Join(checkout, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(outside, "secret"), filepath.Join(checkout, "hardlink")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../secret", "/etc/passwd", "a/../b", "a//b", ".git/config", "escape/secret", "metadata/config", "pipe", "hardlink"} {
		t.Run(name, func(t *testing.T) {
			if _, err := source.Read(name); err == nil {
				t.Fatalf("read accepted unsafe path %q", name)
			}
			if _, err := source.Write(name, []byte("overwrite"), ""); err == nil {
				t.Fatalf("write accepted unsafe path %q", name)
			}
		})
	}
	entries, err := source.List("")
	if err != nil || len(entries) != 0 {
		t.Fatalf("Explorer exposed protected/special entries: %#v, %v", entries, err)
	}
	content, _ := os.ReadFile(filepath.Join(outside, "secret"))
	if string(content) != "not source" {
		t.Fatalf("outside content was modified: %q", content)
	}
}

func TestExplorerOperationsContainProtectedChildren(t *testing.T) {
	source, checkout := testSource(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := source.Mkdir("folder"); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Write("folder/keep.txt", []byte("keep"), ""); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(checkout, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../outside", ".git", "escape/secret", "escape"} {
		if err := source.Mkdir(name); err == nil {
			t.Fatalf("mkdir accepted unsafe path: %s", name)
		}
		if err := source.Delete(name, true); err == nil {
			t.Fatalf("delete accepted unsafe path: %s", name)
		}
		if err := source.Rename("folder/keep.txt", name, true); err == nil {
			t.Fatalf("rename accepted unsafe destination: %s", name)
		}
	}
	if err := os.Mkdir(filepath.Join(checkout, "folder", ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := source.Delete("folder", true); !errors.Is(err, ErrPath) {
		t.Fatalf("recursive delete did not reject protected descendant: %v", err)
	}
	if content, err := os.ReadFile(filepath.Join(checkout, "folder", "keep.txt")); err != nil || string(content) != "keep" {
		t.Fatalf("rejected deletion partially deleted source: %q %v", content, err)
	}
	if content, _ := os.ReadFile(filepath.Join(outside, "secret")); string(content) != "outside" {
		t.Fatalf("explorer operation modified external data: %q", content)
	}
	source.Close()
	if err := source.Mkdir("closed"); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed source admitted mkdir: %v", err)
	}
}

func TestSourceBoundsAndClose(t *testing.T) {
	source, checkout := testSource(t)
	oversize := bytes.Repeat([]byte("x"), MaxFileBytes+1)
	if _, err := source.Write("large", oversize, ""); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "large"), oversize, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Read("large"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize read: %v", err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := source.Read("large"); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed source admitted operation: %v", err)
	}
}

func TestSourceSaveRecoversIdenticalLostAcknowledgement(t *testing.T) {
	source, _ := testSource(t)
	created, err := source.Write("app.ts", []byte("original"), "")
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := source.Write("app.ts", []byte("original"), "")
	if err != nil || replayed.Version != created.Version || replayed.Mtime != created.Mtime {
		t.Fatalf("create acknowledgement recovery rewrote source: %#v, %v", replayed, err)
	}
	saved, err := source.Write("app.ts", []byte("edited"), created.Version)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err = source.Write("app.ts", []byte("edited"), created.Version)
	if err != nil || replayed.Version != saved.Version || replayed.Mtime != saved.Mtime {
		t.Fatalf("save acknowledgement recovery rewrote source: %#v, %v", replayed, err)
	}
}
