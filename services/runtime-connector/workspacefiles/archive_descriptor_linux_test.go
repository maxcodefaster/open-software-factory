package workspacefiles

import (
	"os"
	"testing"
)

func TestSourceArchiveDescriptorRejectsWritableAndForeignRootsWithoutChangingCRUD(t *testing.T) {
	root, source := bundleFixture(t)
	canonical, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer canonical.Close()
	if err := source.AttachArchiveDescriptor(canonical); err == nil {
		t.Fatal("writable canonical tree was accepted as an immutable archive view")
	}
	foreign, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	if err := source.AttachArchiveDescriptor(foreign); err == nil {
		t.Fatal("foreign inode was accepted as Source archive view")
	}
	if _, err := source.Write("owned-after-rejected-view", []byte("owned"), ""); err != nil {
		t.Fatal("rejected archive view changed normal Source writing")
	}
	if data, err := os.ReadFile(root + "/owned-after-rejected-view"); err != nil || string(data) != "owned" {
		t.Fatal("Source CRUD no longer uses canonical Source")
	}
}
