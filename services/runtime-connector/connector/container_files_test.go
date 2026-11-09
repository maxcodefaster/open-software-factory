package connector

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func ownedContainerFiles(t *testing.T) (*containerFileManager, string) {
	t.Helper()
	root := t.TempDir()
	manager, err := newContainerFileManager(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.close)
	return manager, root
}

func fileSHA(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}

func TestContainerFilesHaveVersionedReadsAndConfinedPaths(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("owned-content"), 0644); err != nil {
		t.Fatal(err)
	}
	view, err := manager.read(ContainerFileRequest{Path: "/file", Offset: 2, Limit: 5})
	if err != nil || string(view.Content) != "ned-c" || view.Version != fileSHA([]byte("owned-content")) || view.NextOffset != 7 {
		t.Fatal("incorrect scoped file read", err)
	}
	for _, path := range []string{"relative", "/../file", "/proc/self/environ", "/sys/kernel", "/dev/null"} {
		if _, err := manager.read(ContainerFileRequest{Path: path}); err == nil {
			t.Fatal("unsafe path accepted", path)
		}
	}
	if err := os.Symlink("../outside", filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.read(ContainerFileRequest{Path: "/escape"}); err == nil {
		t.Fatal("symlink escaped the assigned container root")
	}
	if _, err := manager.read(ContainerFileRequest{Path: "/file", Version: strings.Repeat("a", 64)}); err == nil {
		t.Fatal("stale read version was accepted")
	}
}

func TestContainerUploadVerifiesChunksAndPublishesOnlyCompleteBytes(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	content := []byte(strings.Repeat("verified-transfer", 40000))
	id := "30000000-0000-4000-8000-000000000001"
	input := ContainerFileRequest{ID: id, Path: "/artifact.bin", Bytes: int64(len(content)), SHA256: fileSHA(content)}
	if _, err := manager.beginUpload(input); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "artifact.bin")); !os.IsNotExist(err) {
		t.Fatal("partial upload became visible")
	}
	first := content[:maxContainerChunk]
	if _, err := manager.upload(ContainerFileRequest{ID: id, Content: first}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.upload(ContainerFileRequest{ID: id, Content: first}); err != nil {
		t.Fatal("identical chunk retry was refused", err)
	}
	if _, err := manager.upload(ContainerFileRequest{ID: id, Content: []byte("changed")}); err == nil {
		t.Fatal("changed retry bytes were accepted")
	}
	if _, err := manager.commitUpload(ContainerFileRequest{ID: id}); err == nil {
		t.Fatal("incomplete upload was committed")
	}
	for offset := maxContainerChunk; offset < len(content); offset += maxContainerChunk {
		end := min(len(content), offset+maxContainerChunk)
		if _, err := manager.upload(ContainerFileRequest{ID: id, Offset: int64(offset), Content: content[offset:end]}); err != nil {
			t.Fatal(err)
		}
	}
	completed, err := manager.commitUpload(ContainerFileRequest{ID: id})
	if err != nil || !completed.Complete || completed.Version != input.SHA256 {
		t.Fatal("complete upload did not verify", err)
	}
	if _, err := manager.commitUpload(ContainerFileRequest{ID: id}); err != nil {
		t.Fatal("commit acknowledgement could not recover", err)
	}
	actual, err := os.ReadFile(filepath.Join(root, "artifact.bin"))
	if err != nil || string(actual) != string(content) {
		t.Fatal("published upload has different bytes", err)
	}
}

func TestContainerUploadRefusesChangedDestinationAndPreservesForeignTemporary(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	if err := os.WriteFile(filepath.Join(root, "target"), []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	id := "30000000-0000-4000-8000-000000000002"
	input := ContainerFileRequest{ID: id, Path: "/target", Version: fileSHA([]byte("before")), Bytes: 5, SHA256: fileSHA([]byte("after"))}
	if _, err := manager.beginUpload(input); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.upload(ContainerFileRequest{ID: id, Content: []byte("after")}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "target"), []byte("another-writer"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.commitUpload(ContainerFileRequest{ID: id}); err == nil {
		t.Fatal("concurrent destination was overwritten")
	}
	temporary := filepath.Join(root, ".factory-upload-"+id)
	if err := os.Rename(temporary, temporary+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temporary, []byte("foreign"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := manager.release(ContainerFileRequest{ID: id}); err != nil {
		t.Fatal(err)
	}
	if actual, err := os.ReadFile(temporary); err != nil || string(actual) != "foreign" {
		t.Fatal("cleanup removed a different temporary", err)
	}
}

func TestContainerDownloadPinsTheFileAndRejectsChangedBytes(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	content := []byte(strings.Repeat("download", 10000))
	if err := os.WriteFile(filepath.Join(root, "artifact"), content, 0644); err != nil {
		t.Fatal(err)
	}
	id := "30000000-0000-4000-8000-000000000003"
	prepared, err := manager.beginDownload(ContainerFileRequest{ID: id, Path: "/artifact"})
	if err != nil || prepared.Version != fileSHA(content) {
		t.Fatal("download did not bind content", err)
	}
	view, err := manager.download(ContainerFileRequest{ID: id, Limit: 1024})
	if err != nil || string(view.Content) != string(content[:1024]) || view.NextOffset != 1024 {
		t.Fatal("wrong download chunk", err)
	}
	if err := os.WriteFile(filepath.Join(root, "artifact"), []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.download(ContainerFileRequest{ID: id}); err == nil {
		t.Fatal("changed download was presented as immutable")
	}
}

func TestContainerFileListingHasAnExplicitNextPage(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	for _, name := range []string{"a", "b", "c"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	first, err := manager.list(ContainerFileRequest{Path: "/", Limit: 2})
	if err != nil || len(first.Entries) != 2 || first.NextOffset == nil || *first.NextOffset != 2 {
		t.Fatal("listing did not report continuation", err)
	}
	last, err := manager.list(ContainerFileRequest{Path: "/", Offset: *first.NextOffset, Limit: 2})
	if err != nil || len(last.Entries) != 1 || last.Entries[0].Path != "/c" || last.NextOffset != nil {
		t.Fatal("listing did not finish at the final page", err)
	}
}

func TestContainerUploadChecksumFailureNeverPublishesAndExpiredHandlesCleanUp(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	id := "30000000-0000-4000-8000-000000000004"
	if _, err := manager.beginUpload(ContainerFileRequest{ID: id, Path: "/target", Bytes: 5, SHA256: fileSHA([]byte("right"))}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.upload(ContainerFileRequest{ID: id, Content: []byte("wrong")}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.commitUpload(ContainerFileRequest{ID: id}); err == nil {
		t.Fatal("incorrect checksum was published")
	}
	if _, err := os.Stat(filepath.Join(root, "target")); !os.IsNotExist(err) {
		t.Fatal("failed upload was visible")
	}
	manager.transfers[id].expires = time.Now().Add(-time.Second)
	manager.sweep()
	if _, err := manager.status(ContainerFileRequest{ID: id}); err == nil {
		t.Fatal("expired native handle stayed available")
	}
	if _, err := os.Stat(filepath.Join(root, ".factory-upload-"+id)); !os.IsNotExist(err) {
		t.Fatal("expired upload left its owned temporary")
	}
}

func TestContainerRenameAndNewUploadNeverReplaceExistingDestinations(t *testing.T) {
	manager, root := ownedContainerFiles(t)
	for _, name := range []string{"source", "destination"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.mutate("file-rename", ContainerFileRequest{Path: "/source", Destination: "/destination"}); err == nil {
		t.Fatal("rename replaced an existing destination")
	}
	if _, err := manager.mutate("file-rename", ContainerFileRequest{Path: "/source", Destination: "/moved"}); err != nil {
		t.Fatal(err)
	}
	id := "30000000-0000-4000-8000-000000000005"
	if _, err := manager.beginUpload(ContainerFileRequest{ID: id, Path: "/new", Bytes: 0, SHA256: fileSHA(nil)}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new"), []byte("concurrent"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.commitUpload(ContainerFileRequest{ID: id}); err == nil {
		t.Fatal("new upload replaced a concurrent file")
	}
	if actual, err := os.ReadFile(filepath.Join(root, "new")); err != nil || string(actual) != "concurrent" {
		t.Fatal("concurrent file was lost", err)
	}
}
