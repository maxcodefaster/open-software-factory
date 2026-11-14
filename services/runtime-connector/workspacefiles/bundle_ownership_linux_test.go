package workspacefiles

import (
	"archive/tar"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestSourceBundleNativeArchiveViewRoundTrip(t *testing.T) {
	expected := os.Getenv("FACTORY_NATIVE_SOURCE_CODEC_ACTOR_UID")
	if expected == "" {
		t.Skip("explicit owned native Actor proof")
	}
	actual, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || strings.TrimSpace(string(actual)) != expected ||
		!regexp.MustCompile(`^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`).MatchString(expected) ||
		os.Geteuid() != 0 || os.Getegid() != 0 {
		t.Fatal("native archive proof requires the original Actor projection and private RootlessKit root")
	}
	attach := func(source *Source) {
		t.Helper()
		target := filepath.Join(t.TempDir(), "archive-view")
		if err := os.Mkdir(target, 0700); err != nil {
			t.Fatal(err)
		}
		if err := unix.Mount(source.root.Name(), target, "", unix.MS_BIND, ""); err != nil {
			t.Fatal(err)
		}
		flags := uintptr(unix.MS_BIND | unix.MS_REMOUNT | unix.MS_RDONLY | unix.MS_NOATIME | unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC)
		if err := unix.Mount("", target, "", flags, ""); err != nil {
			_ = unix.Unmount(target, 0)
			t.Fatal(err)
		}
		file, err := os.Open(target)
		if err != nil {
			_ = unix.Unmount(target, 0)
			t.Fatal(err)
		}
		t.Cleanup(func() {
			source.Close()
			file.Close()
			if err := unix.Unmount(target, 0); err != nil {
				t.Error(err)
			}
		})
		if err := source.AttachArchiveDescriptor(file); err != nil {
			t.Fatal(err)
		}
	}
	_, source := bundleFixture(t)
	attach(source)
	output, err := os.CreateTemp(t.TempDir(), "source-")
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	first, err := source.ExportBundle(output)
	if err != nil || first.Version != 1 {
		t.Fatalf("normal native Source bundle unavailable: %v", err)
	}
	dest := filepath.Join(t.TempDir(), "project")
	if err := MaterializeBundle(output, dest); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	attach(restored)
	copy, err := os.CreateTemp(t.TempDir(), "source-copy-")
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	second, err := restored.ExportBundle(copy)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("native Source round trip changed dirty Git, links, xattrs or nanosecond metadata: %v", err)
	}
}

func TestSourceBundleRejectsRootLockfileWithoutChangingItsMetadata(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires owned root Linux fixture")
	}
	for _, relative := range []string{".devcontainer/devcontainer-lock.json", ".devcontainer-lock.json"} {
		t.Run(relative, func(t *testing.T) {
			root, source := bundleFixture(t)
			if err := os.MkdirAll(filepath.Join(root, ".devcontainer"), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(filepath.Join(root, ".devcontainer"), 1000, 1000); err != nil {
				t.Fatal(err)
			}
			lockfile := filepath.Join(root, relative)
			if err := os.WriteFile(lockfile, []byte("{}\n"), 0644); err != nil {
				t.Fatal(err)
			}
			stamp := time.Unix(1_790_000_000, 987654321)
			if err := unix.UtimesNanoAt(unix.AT_FDCWD, lockfile, []unix.Timespec{
				unix.NsecToTimespec(stamp.UnixNano() - 123),
				unix.NsecToTimespec(stamp.UnixNano()),
			}, 0); err != nil {
				t.Fatal(err)
			}
			var before, after unix.Stat_t
			if err := unix.Lstat(lockfile, &before); err != nil {
				t.Fatal(err)
			}
			archive, err := os.CreateTemp(t.TempDir(), "source-")
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			if _, err := source.ExportBundle(archive); err == nil {
				t.Fatal("Source export admitted root-owned CLI metadata")
			}
			if err := unix.Lstat(lockfile, &after); err != nil || before != after {
				t.Fatal("rejected Source export modified root-owned metadata")
			}
		})
	}
}

func TestSourceMaterializationRejectsRootMetadataBeforeCreatingAProject(t *testing.T) {
	for _, name := range []string{".", ".devcontainer-lock.json", ".devcontainer/devcontainer-lock.json"} {
		t.Run(name, func(t *testing.T) {
			archive, err := os.CreateTemp(t.TempDir(), "source-")
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			writer := tar.NewWriter(archive)
			headers := []*tar.Header{{Name: ".", Typeflag: tar.TypeDir, Mode: 0755, Uid: 1000, Gid: 1000}}
			if name == "." {
				headers[0].Uid, headers[0].Gid = 0, 0
			} else {
				if filepath.Dir(name) != "." {
					headers = append(headers, &tar.Header{Name: ".devcontainer", Typeflag: tar.TypeDir, Mode: 0755, Uid: 1000, Gid: 1000})
				}
				headers = append(headers, &tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Uid: 0, Gid: 0})
			}
			for _, header := range headers {
				if err := writer.WriteHeader(header); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(t.TempDir(), "project")
			if err := MaterializeBundle(archive, destination); err == nil {
				t.Fatal("Source materialization admitted root metadata")
			}
			if _, err := os.Lstat(destination); !os.IsNotExist(err) {
				t.Fatal("rejected root archive published a checkout")
			}
		})
	}
}
