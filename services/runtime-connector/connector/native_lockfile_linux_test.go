package connector

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
	"golang.org/x/sys/unix"
)

func nativeLockfileFixture(t *testing.T, config string) Assignment {
	t.Helper()
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		t.Skip("requires owned root or development-user fixture")
	}
	// The development-user shell must be able to traverse the fixture's parent;
	// testing.T's private temporary ancestors are intentionally root-only.
	parent, err := os.MkdirTemp("", "factory-native-lockfile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent) })
	if err := os.Chmod(parent, 0755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(parent, "project")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, config)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := filepath.WalkDir(root, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chown(name, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	assignment := Assignment{WorkspaceFolder: root, ActorTemplatePath: config}
	assignment.SetNativeActorUID("owned-actor")
	return assignment
}

func TestNativeLockfileCheckOnlyPreservesMissingAndAuthoredFiles(t *testing.T) {
	for _, contents := range []string{"missing", "", "{\"features\":{\"owned/local\":{\"version\":\"1.0.0\"}}}\n"} {
		t.Run(contents, func(t *testing.T) {
			assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
			file := filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json")
			var before unix.Stat_t
			if contents != "missing" {
				if err := os.WriteFile(file, []byte(contents), 0640); err != nil {
					t.Fatal(err)
				}
				if err := os.Chown(file, 1000, 1000); err != nil {
					t.Fatal(err)
				}
				if err := unix.Lstat(file, &before); err != nil {
					t.Fatal(err)
				}
			}
			if err := checkNativeDevcontainerLockfile(assignment); err != nil {
				t.Fatal(err)
			}
			if contents == "missing" {
				if _, err := os.Lstat(file); !os.IsNotExist(err) {
					t.Fatalf("check-only admission created a missing lockfile: %v", err)
				}
				return
			}
			if err := reserveNativeDevcontainerLockfile(assignment); err != nil {
				t.Fatal(err)
			}
			var after unix.Stat_t
			if err := unix.Lstat(file, &after); err != nil || before != after {
				t.Fatalf("retained empty/populated inode or metadata changed: %v", err)
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != contents {
				t.Fatal("retained lockfile contents changed")
			}
		})
	}
}

func TestNativeLockfileReservationPreservesWriteOwnershipAndSourceMetadata(t *testing.T) {
	for _, config := range []string{".devcontainer/devcontainer.json", ".devcontainer.json", "custom/config.json"} {
		t.Run(config, func(t *testing.T) {
			assignment := nativeLockfileFixture(t, config)
			if err := reserveNativeDevcontainerLockfile(assignment); err != nil {
				t.Fatal(err)
			}
			name := "devcontainer-lock.json"
			if filepath.Base(config) == ".devcontainer.json" {
				name = ".devcontainer-lock.json"
			}
			file := filepath.Join(assignment.WorkspaceFolder, filepath.Dir(config), name)
			var before, after unix.Stat_t
			if err := unix.Lstat(file, &before); err != nil || before.Uid != 1000 || before.Gid != 1000 || before.Size != 0 {
				t.Fatal("missing lockfile was not reserved as development metadata")
			}
			if err := os.WriteFile(file, []byte("{\"features\":{}}\n"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := reserveNativeDevcontainerLockfile(assignment); err != nil {
				t.Fatal(err)
			}
			if err := unix.Lstat(file, &after); err != nil || after.Uid != 1000 || after.Gid != 1000 || before.Ino != after.Ino {
				t.Fatal("write or repeated preparation changed ownership/inode")
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != "{\"features\":{}}\n" {
				t.Fatal("existing lockfile metadata was truncated or changed")
			}
		})
	}
}

func TestNativeSourceRoundTripPreservesPreparedDependenciesAndLockfiles(t *testing.T) {
	assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
	if err := reserveNativeDevcontainerLockfile(assignment); err != nil {
		t.Fatal(err)
	}
	// Exercise a real development-user shell, not the retired image producer or
	// an emulation of upstream lockfile code. Source must preserve both its
	// authored lockfiles and installed dependency bytes through a cold handoff.
	command := ownedCommand(t.Context(), "/bin/sh", "-ec", `
printf '%s\n' '{"features":{"owned/local":{"version":"1.0.0"}}}' >.devcontainer/devcontainer-lock.json
printf '%s\n' '{"lockfileVersion":3}' >package-lock.json
mkdir -p node_modules/owned
printf '%s\n' 'module.exports="retained offline dependency";' >node_modules/owned/index.js
`)
	command.Dir = assignment.WorkspaceFolder
	if os.Geteuid() == 0 {
		command.SysProcAttr.Credential = &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}}
	}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native preparation shell: %v %s", err, output)
	}
	if err := checkNativeDevcontainerLockfile(assignment); err != nil {
		t.Fatal(err)
	}
	source, err := workspacefiles.Open(assignment.WorkspaceFolder)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	archive, err := os.CreateTemp(t.TempDir(), "source-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if _, err := source.ExportBundle(archive); err != nil {
		t.Fatalf("prepared Source cannot be completely exported: %v", err)
	}
	restored := filepath.Join(t.TempDir(), "project")
	if err := workspacefiles.MaterializeBundle(archive, restored); err != nil {
		t.Fatal(err)
	}
	for name, expected := range map[string]string{
		".devcontainer/devcontainer-lock.json": "{\"features\":{\"owned/local\":{\"version\":\"1.0.0\"}}}\n",
		"package-lock.json":                    "{\"lockfileVersion\":3}\n",
		"node_modules/owned/index.js":          "module.exports=\"retained offline dependency\";\n",
	} {
		path := filepath.Join(restored, name)
		var before, after unix.Stat_t
		if unix.Lstat(filepath.Join(assignment.WorkspaceFolder, name), &before) != nil ||
			unix.Lstat(path, &after) != nil || after.Uid != 1000 || after.Gid != 1000 ||
			before.Mode != after.Mode {
			t.Fatalf("Source changed prepared file ownership or mode: %s", name)
		}
		if content, err := os.ReadFile(path); err != nil || string(content) != expected {
			t.Fatalf("Source changed prepared dependency/lockfile bytes: %s: %v", name, err)
		}
	}
}

func TestNativeLockfileReservationRefusesExistingUnsupportedMetadataWithoutMutation(t *testing.T) {
	for _, kind := range []string{"root-owner", "foreign-group", "privileged-mode", "symlink", "hardlink", "directory", "parent-symlink", "escape"} {
		t.Run(kind, func(t *testing.T) {
			assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
			file := filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json")
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("retained"), 0644); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "root-owner", "foreign-group", "privileged-mode":
				if os.Geteuid() != 0 {
					t.Skip("requires owned root fixture")
				}
				if err := os.WriteFile(file, []byte("retained"), 0644); err != nil {
					t.Fatal(err)
				}
				if kind == "foreign-group" {
					if err := os.Chown(file, 1000, 1234); err != nil {
						t.Fatal(err)
					}
				}
				if kind == "privileged-mode" {
					if err := os.Chown(file, 1000, 1000); err != nil {
						t.Fatal(err)
					}
					if err := unix.Chmod(file, 04755); err != nil {
						t.Fatal(err)
					}
				}
			case "symlink":
				if err := os.Symlink(outside, file); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Chown(outside, 1000, 1000); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(outside, file); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(file, 0755); err != nil {
					t.Fatal(err)
				}
			case "parent-symlink":
				assignment.ActorTemplatePath = "linked/devcontainer.json"
				if err := os.Symlink(filepath.Dir(outside), filepath.Join(assignment.WorkspaceFolder, "linked")); err != nil {
					t.Fatal(err)
				}
			case "escape":
				assignment.ActorTemplatePath = "../devcontainer.json"
			}
			var before unix.Stat_t
			unix.Lstat(file, &before)
			if err := checkNativeDevcontainerLockfile(assignment); err == nil {
				t.Fatal("check-only admission accepted unsupported metadata")
			}
			if err := reserveNativeDevcontainerLockfile(assignment); err == nil {
				t.Fatal("unsupported metadata accepted")
			}
			var after unix.Stat_t
			unix.Lstat(file, &after)
			if before != after {
				t.Fatal("retained metadata was modified")
			}
			if data, err := os.ReadFile(outside); err != nil || string(data) != "retained" {
				t.Fatal("outside data changed")
			}
		})
	}
}
