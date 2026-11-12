package workspacefiles

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func TestBundleRechecksDirectoryEntriesAndFileMetadataBeforePublication(t *testing.T) {
	for _, change := range []string{"directory-entry", "file-mode", "file-xattr", "file-inode", "symlink-inode"} {
		t.Run(change, func(t *testing.T) {
			root, source := bundleFixture(t)
			name := "tracked"
			if change == "directory-entry" {
				name = "."
			}
			if change == "symlink-inode" {
				name = "relative-link"
			}
			if change == "directory-entry" {
				if err := unix.UtimesNanoAt(unix.AT_FDCWD, root, []unix.Timespec{{Sec: 1790000000, Nsec: 1}, {Sec: 1790000000, Nsec: 2}}, 0); err != nil {
					t.Fatal(err)
				}
			}
			info, err := os.Lstat(filepath.Join(root, name))
			if err != nil {
				t.Fatal(err)
			}
			expected := *info.Sys().(*syscall.Stat_t)
			attrs, err := sourceXattrs(filepath.Join(root, name))
			if err != nil {
				t.Fatal(err)
			}
			if err := source.verifyBundleEntry(name, expected, attrs); err != nil {
				t.Fatal("stable original metadata was refused")
			}
			switch change {
			case "directory-entry":
				if err := os.WriteFile(filepath.Join(root, "late-unknown-file"), []byte("retained late bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			case "file-mode":
				if err := os.Chmod(filepath.Join(root, name), 0640); err != nil {
					t.Fatal(err)
				}
			case "file-xattr":
				if err := unix.Lsetxattr(filepath.Join(root, name), "user.late", []byte("retained attribute"), 0); err != nil {
					t.Fatal(err)
				}
			case "file-inode":
				if err := os.WriteFile(filepath.Join(root, "replacement"), []byte("replacement bytes"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(root, "replacement"), filepath.Join(root, name)); err != nil {
					t.Fatal(err)
				}
			case "symlink-inode":
				if err := os.Remove(filepath.Join(root, name)); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("untracked", filepath.Join(root, name)); err != nil {
					t.Fatal(err)
				}
			}
			if err := source.verifyBundleEntry(name, expected, attrs); !errors.Is(err, ErrConflict) {
				t.Fatal("changed or incomplete Source metadata was accepted")
			}
			if _, err := os.Lstat(filepath.Join(root, name)); err != nil {
				t.Fatal("denied archive validation removed retained Source")
			}
		})
	}
}

func TestBundleRechecksDirectoryNamesEvenWithoutRelyingOnTimestampResolution(t *testing.T) {
	root, source := bundleFixture(t)
	before, err := source.bundleChildren(".")
	if err != nil {
		t.Fatal(err)
	}
	if err := source.verifyBundleChildren(".", before); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "late-unknown-file"), []byte("retained late bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := source.verifyBundleChildren(".", before); !errors.Is(err, ErrConflict) {
		t.Fatal("late unknown directory entry was omitted")
	}
}
