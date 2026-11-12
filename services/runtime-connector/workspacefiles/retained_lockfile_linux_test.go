package workspacefiles

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestRetainedLockfilePreservationDoesNotChangeNormalSourcePolicyOrOriginalMetadata(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires owned root fixture")
	}
	root, source := bundleFixture(t)
	if err := os.Mkdir(filepath.Join(root, ".devcontainer"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(filepath.Join(root, ".devcontainer"), 1000, 1000); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(root, ".devcontainer/devcontainer-lock.json")
	if err := os.WriteFile(lock, []byte("{\"features\":{\"retained\":{\"version\":\"1.0.0\"}}}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	stamp := time.Unix(1_790_000_000, 987654321)
	if err := unix.UtimesNanoAt(unix.AT_FDCWD, lock, []unix.Timespec{unix.NsecToTimespec(stamp.UnixNano() - 123), unix.NsecToTimespec(stamp.UnixNano())}, 0); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lsetxattr(lock, "user.factory-retained", []byte{0, 1, 255}, 0); err != nil {
		t.Fatal(err)
	}
	var before, after unix.Stat_t
	if err := unix.Lstat(lock, &before); err != nil {
		t.Fatal(err)
	}
	archive, err := os.CreateTemp(t.TempDir(), "preservation-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if _, err := source.ExportBundle(archive); err == nil {
		t.Fatal("normal Source export accepted root metadata")
	}
	saved, err := source.ExportRetainedLockfileBundle(archive)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != 2 {
		t.Fatal("recovery archive masquerades as a normal Source generation")
	}
	if err := unix.Lstat(lock, &after); err != nil || before != after {
		t.Fatal("read-only preservation altered original lockfile metadata")
	}
	denied := filepath.Join(t.TempDir(), "project")
	if MaterializeBundle(archive, denied) == nil {
		t.Fatal("normal Source materialization accepted root metadata")
	}
	if _, err := os.Lstat(denied); !os.IsNotExist(err) {
		t.Fatal("normal Source materialization published an unsupported tree")
	}
	restored := filepath.Join(t.TempDir(), "project")
	if err := MaterializeRetainedLockfileBundle(archive, restored); err != nil {
		t.Fatal(err)
	}
	var copyStat unix.Stat_t
	if err := unix.Lstat(filepath.Join(restored, ".devcontainer/devcontainer-lock.json"), &copyStat); err != nil || copyStat.Uid != 0 || copyStat.Gid != 0 || copyStat.Mode != before.Mode || copyStat.Mtim != before.Mtim || copyStat.Atim != before.Atim {
		t.Fatal("root metadata was flattened or lost during recovery")
	}
	copySource, err := Open(restored)
	if err != nil {
		t.Fatal(err)
	}
	defer copySource.Close()
	copyFile, err := os.CreateTemp(t.TempDir(), "roundtrip-")
	if err != nil {
		t.Fatal(err)
	}
	defer copyFile.Close()
	copyBundle, err := copySource.ExportRetainedLockfileBundle(copyFile)
	if err != nil || !reflect.DeepEqual(saved, copyBundle) {
		t.Fatalf("complete retained Source roundtrip differs: %v", err)
	}
	if err := unix.Lstat(lock, &after); err != nil || before != after {
		t.Fatal("recovery proof modified original lockfile")
	}
}

func TestRetainedLockfilePreservationDoesNotAdmitOtherRootEntries(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires owned root fixture")
	}
	for _, kind := range []string{"other-path", "other-mode", "other-group", "symlink", "hardlink", "directory"} {
		t.Run(kind, func(t *testing.T) {
			root, source := bundleFixture(t)
			name := ".devcontainer-lock.json"
			if kind == "other-path" {
				name = "other-root-file"
			}
			file := filepath.Join(root, name)
			switch kind {
			case "directory":
				if err := os.Mkdir(file, 0644); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink("tracked", file); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.WriteFile(file, []byte("retained"), 0644); err != nil {
					t.Fatal(err)
				}
				if kind == "other-mode" {
					if err := os.Chmod(file, 0600); err != nil {
						t.Fatal(err)
					}
				}
				if kind == "other-group" {
					if err := os.Chown(file, 0, 1000); err != nil {
						t.Fatal(err)
					}
				}
				if kind == "hardlink" {
					if err := os.Link(file, filepath.Join(root, "root-link")); err != nil {
						t.Fatal(err)
					}
				}
			}
			archive, err := os.CreateTemp(t.TempDir(), "preservation-")
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			if _, err := source.ExportRetainedLockfileBundle(archive); err == nil {
				t.Fatal("unqualified root metadata was accepted")
			}
		})
	}
}

func TestRetainedMaterializationRejectsRootOwnershipOutsideTheExactMetadataCase(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires owned root fixture")
	}
	for _, change := range []string{"root-directory", "other-path", "other-mode", "other-group", "hardlink"} {
		t.Run(change, func(t *testing.T) {
			file, err := os.CreateTemp(t.TempDir(), "archive-")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			w := tar.NewWriter(file)
			root := &tar.Header{Name: ".", Typeflag: tar.TypeDir, Mode: 0755, Uid: 1000, Gid: 1000}
			if change == "root-directory" {
				root.Uid, root.Gid = 0, 0
			}
			if err := w.WriteHeader(root); err != nil {
				t.Fatal(err)
			}
			h := &tar.Header{Name: ".devcontainer-lock.json", Typeflag: tar.TypeReg, Mode: 0644, Uid: 0, Gid: 0, Size: 1}
			if change == "other-path" {
				h.Name = "other-root-file"
			}
			if change == "other-mode" {
				h.Mode = 0600
			}
			if change == "other-group" {
				h.Gid = 1000
			}
			if err := w.WriteHeader(h); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Write([]byte("x")); err != nil {
				t.Fatal(err)
			}
			if change == "hardlink" {
				if err := w.WriteHeader(&tar.Header{Name: "link", Typeflag: tar.TypeLink, Mode: 0644, Uid: 1000, Gid: 1000, Linkname: h.Name}); err != nil {
					t.Fatal(err)
				}
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(t.TempDir(), "project")
			if MaterializeRetainedLockfileBundle(file, destination) == nil {
				t.Fatal("unqualified root archive was accepted")
			}
			if _, err := os.Lstat(destination); !os.IsNotExist(err) {
				t.Fatal("invalid archive published a tree")
			}
		})
	}
}

func TestRetainedSourcePreservationRequiresRootRatherThanProjectingOwnership(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires non-root development-user fixture")
	}
	root := t.TempDir()
	source, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	archive, err := os.CreateTemp(t.TempDir(), "preservation-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if _, err := source.ExportRetainedLockfileBundle(archive); err == nil {
		t.Fatal("unprivileged recovery export accepted")
	}
	destination := filepath.Join(t.TempDir(), "project")
	if MaterializeRetainedLockfileBundle(archive, destination) == nil {
		t.Fatal("unprivileged recovery materialization accepted")
	}
	if data, err := os.ReadFile(archive.Name()); err != nil || !bytes.Equal(data, []byte{}) {
		t.Fatal("denied recovery modified archive")
	}
}
