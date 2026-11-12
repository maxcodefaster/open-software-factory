package connector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
	"golang.org/x/sys/unix"
)

func nativeLockfileFixture(t *testing.T, config string) Assignment {
	t.Helper()
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		t.Skip("requires owned root or development-user fixture")
	}
	root := filepath.Join(t.TempDir(), "project")
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
	return Assignment{WorkspaceFolder: root, DevcontainerPath: config, nativeActorUID: "owned-actor"}
}

func TestNativeLockfileReservationPreservesCLIWriteOwnershipAndSourceMetadata(t *testing.T) {
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
				t.Fatal("CLI write or repeated preparation changed ownership/inode")
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != "{\"features\":{}}\n" {
				t.Fatal("existing CLI metadata was truncated or changed")
			}
		})
	}
}

func TestNativeLockfilePinnedCLIWriteAndFrozenVerification(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("native image qualification supplies Node and the pinned CLI")
	}
	cli := "/usr/local/lib/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js"
	if _, err := os.Stat(cli); err != nil {
		t.Skip("requires the actual pinned runtime image")
	}
	assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
	if err := reserveNativeDevcontainerLockfile(assignment); err != nil {
		t.Fatal(err)
	}
	// Execute the unmodified upstream lockfile functions from the pinned bundle,
	// with no Docker socket, Project checkout, network or credentials. This checks
	// generation and frozen verification, not only an equivalent write primitive.
	script := `const fs=require('fs'),vm=require('vm'),util=require('util');
	const source=fs.readFileSync(process.argv[1],'utf8');
	const start=source.indexOf('async function sQ('),end=source.indexOf('var CQ=',start);
	if(start<0||end<0)throw Error('Pinned CLI lockfile implementation changed');
	const context={ag:require('path'),ee:util.promisify(fs.readFile),ye:util.promisify(fs.writeFile),Buffer};
	vm.createContext(context);vm.runInContext(source.slice(start,end),context);
	(async()=>{const config=process.argv[2],data={features:{'owned/local':{version:'1.0.0'}}};
	await context.sQ({},config,data);await context.sQ({frozenLockfile:true},config,data);
	const file=context.gQ(config),before=fs.readFileSync(file);
	let denied=false;try{await context.sQ({frozenLockfile:true},config,{features:{}})}catch(e){if(e.message!=='Lockfile does not match.')throw e;denied=true;}
	if(!denied||!before.equals(fs.readFileSync(file)))throw Error('Frozen verification did not preserve the exact lockfile');
	})().catch(e=>{console.error(e);process.exitCode=1});`
	command := exec.Command("node", "-e", script, cli, filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin"}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned CLI metadata: %v %s", err, output)
	}
	var stat unix.Stat_t
	if err := unix.Lstat(filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json"), &stat); err != nil || stat.Uid != 1000 || stat.Gid != 1000 || stat.Size == 0 {
		t.Fatal("pinned CLI generated unsupported Source ownership")
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
		t.Fatalf("actual CLI metadata cannot be completely exported: %v", err)
	}
	restored := filepath.Join(t.TempDir(), "project")
	if err := workspacefiles.MaterializeBundle(archive, restored); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lstat(filepath.Join(restored, ".devcontainer/devcontainer-lock.json"), &stat); err != nil || stat.Uid != 1000 || stat.Gid != 1000 || stat.Size == 0 {
		t.Fatal("Source did not preserve actual CLI metadata ownership")
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
				assignment.DevcontainerPath = "linked/devcontainer.json"
				if err := os.Symlink(filepath.Dir(outside), filepath.Join(assignment.WorkspaceFolder, "linked")); err != nil {
					t.Fatal(err)
				}
			case "escape":
				assignment.DevcontainerPath = "../devcontainer.json"
			}
			var before unix.Stat_t
			unix.Lstat(file, &before)
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

func TestNativeConfigurationRefusesRootLockfileBeforeInvokingCLI(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires owned root fixture")
	}
	assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
	if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json"), []byte("retained"), 0644); err != nil {
		t.Fatal(err)
	}
	// No executable is available: the ownership fence must win before CLI work.
	t.Setenv("PATH", t.TempDir())
	if _, err := validateDevcontainerConfiguration(context.Background(), assignment, false); err == nil || err.Error() != "native Dev Container lockfile ownership is unavailable; existing metadata retained" {
		t.Fatalf("CLI invocation was not fenced by retained metadata: %v", err)
	}
}
