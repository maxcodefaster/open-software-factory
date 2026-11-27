package workspacefiles

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"golang.org/x/sys/unix"
)

func TestMaterializeBundleSyncsCompleteTreeBeforeSuccess(t *testing.T) {
	_, source := bundleFixture(t)
	archive, err := os.CreateTemp(t.TempDir(), "bundle-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	want, err := source.ExportBundle(archive)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "project")
	calls := 0
	err = materializeBundle(archive, destination, func(fd int) error {
		calls++
		var opened, restored unix.Stat_t
		if err := unix.Fstat(fd, &opened); err != nil {
			t.Fatal(err)
		}
		if err := unix.Stat(destination, &restored); err != nil {
			t.Fatal(err)
		}
		if opened.Dev != restored.Dev || opened.Ino != restored.Ino || opened.Mode&unix.S_IFMT != unix.S_IFDIR {
			t.Fatal("durability barrier does not own the staging directory")
		}
		tree, err := Open(destination)
		if err != nil {
			t.Fatal(err)
		}
		defer tree.Close()
		output, err := os.CreateTemp(t.TempDir(), "restored-")
		if err != nil {
			t.Fatal(err)
		}
		defer output.Close()
		got, err := tree.ExportBundle(output)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("durability barrier ran before complete bytes/links/metadata: %v", err)
		}
		return unix.Syncfs(fd)
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("complete staging tree must cross exactly one durability barrier, got %d", calls)
	}
}

func TestMaterializeBundleDurabilityFailureNeverSucceeds(t *testing.T) {
	for _, failure := range []error{unix.EIO, unix.ENOSYS} {
		t.Run(failure.Error(), func(t *testing.T) {
			_, source := bundleFixture(t)
			archive, err := os.CreateTemp(t.TempDir(), "bundle-")
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			if _, err := source.ExportBundle(archive); err != nil {
				t.Fatal(err)
			}
			calls := 0
			err = materializeBundle(archive, filepath.Join(t.TempDir(), "project"), func(int) error {
				calls++
				return failure
			})
			if !errors.Is(err, failure) || calls != 1 {
				t.Fatalf("unconfirmed durability must fail closed without fallback: calls=%d err=%v", calls, err)
			}
		})
	}
}
