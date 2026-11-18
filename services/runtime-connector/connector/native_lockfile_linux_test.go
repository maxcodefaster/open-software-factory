package connector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
	"golang.org/x/sys/unix"
)

// Component-only regression through the real startup caller and packaged CLI.
// Only Docker's empty read-only inventory is substituted. This is not Docker or
// native lifecycle acceptance; no socket, network, model or retained Project is used.
func TestNativeLockfileFeaturelessCLIConfigurationLeavesNoReservation(t *testing.T) {
	assignment, checkCLI := nativeLockfilePinnedCLIFixture(t)
	config := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	recipe := []byte("{\"image\":\"owned-featureless-image\",\"remoteUser\":\"node\"}\n")
	if err := os.WriteFile(config, recipe, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(config, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	_, cliErr := validateDevcontainerConfiguration(context.Background(), assignment, false)
	checkCLI(cliErr)
	lockfile := filepath.Join(filepath.Dir(config), "devcontainer-lock.json")
	if info, err := os.Lstat(lockfile); !os.IsNotExist(err) {
		if err != nil {
			t.Fatal(err)
		}
		t.Fatalf("actual featureless CLI startup retained an unexpected %d-byte devcontainer-lock.json", info.Size())
	}
	if data, err := os.ReadFile(config); err != nil || string(data) != string(recipe) {
		t.Fatal("startup changed the authored featureless recipe")
	}
}

func TestNativeLockfilePinnedCLIResolvedFeaturesAndEffectiveConfiguration(t *testing.T) {
	for _, scenario := range []string{"features", "dependency-override-features", "prebuild-override-without-features"} {
		t.Run(scenario, func(t *testing.T) {
			assignment, checkCLI := nativeLockfilePinnedCLIFixture(t)
			config := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
			featureRecipe := `{"image":"owned-image","features":{"./owned-local-feature":{}}}`
			plainRecipe := `{"image":"owned-image"}`
			recipe := featureRecipe
			if scenario != "features" {
				assignment.EffectiveConfiguration = filepath.Join(t.TempDir(), "devcontainer.json")
				effective := featureRecipe
				if scenario == "dependency-override-features" {
					recipe = plainRecipe
				} else {
					effective = plainRecipe
				}
				if err := os.WriteFile(assignment.EffectiveConfiguration, []byte(effective), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Plain read-configuration must return the actual upstream Feature
			// DTO without resolving or installing this local Feature.
			if err := os.WriteFile(config, []byte(recipe), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(config, 1000, 1000); err != nil {
				t.Fatal(err)
			}
			_, err := validateDevcontainerConfiguration(context.Background(), assignment, false)
			checkCLI(err)
			lockfile := filepath.Join(filepath.Dir(config), "devcontainer-lock.json")
			if scenario == "prebuild-override-without-features" {
				if _, err := os.Lstat(lockfile); !os.IsNotExist(err) {
					t.Fatalf("prebuilt effective recipe without Features created metadata: %v", err)
				}
			} else {
				var stat unix.Stat_t
				if err := unix.Lstat(lockfile, &stat); err != nil || stat.Uid != 1000 || stat.Gid != 1000 || stat.Size != 0 {
					t.Fatalf("actual CLI Feature DTO did not reserve a development-owned inode: %+v, %v", stat, err)
				}
			}
			if data, err := os.ReadFile(config); err != nil || string(data) != recipe {
				t.Fatal("reading the effective Feature DTO changed authored configuration")
			}
		})
	}
}

func nativeLockfilePinnedCLIFixture(t *testing.T) (Assignment, func(error)) {
	t.Helper()
	cli, err := exec.LookPath("devcontainer")
	if err != nil {
		t.Skip("requires the actual pinned runtime image")
	}
	version, err := exec.Command(cli, "--version").Output()
	if err != nil || strings.TrimSpace(string(version)) != prebuildCLIVersion {
		t.Fatalf("requires pinned CLI %s, got %q: %v", prebuildCLIVersion, version, err)
	}
	assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
	assignment.RegistryCAFile = "/etc/ssl/certs/ca-certificates.crt"
	if _, err := os.Stat(assignment.RegistryCAFile); err != nil {
		t.Fatalf("packaged public system CA is unavailable: %v", err)
	}
	config := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	// Preserve the production arguments and the unmodified pinned CLI. Capture
	// both streams from that exact invocation so a CLI prerequisite failure
	// cannot be mistaken for the regression's no-file assertion.
	diagnostics := t.TempDir()
	stdout := filepath.Join(diagnostics, "stdout")
	stderr := filepath.Join(diagnostics, "stderr")
	wrapper := fmt.Sprintf("#!/bin/sh\n%q \"$@\" >%q 2>%q\nstatus=$?\ncat %q\ncat %q >&2\nexit \"$status\"\n",
		cli, stdout, stderr, stdout, stderr)
	if err := os.WriteFile(filepath.Join(diagnostics, "devcontainer"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	inventory := filepath.Join(diagnostics, "docker-inventory.log")
	unexpected := filepath.Join(diagnostics, "docker-unexpected.log")
	// Match the exact observed ps argv and both owned paths. Never forward a
	// command to Docker, and reject even an otherwise read-only unexpected call.
	docker := fmt.Sprintf(`#!/bin/sh
if { [ "$#" -eq 7 ] || [ "$#" -eq 5 ]; } &&
   [ "$1" = ps ] && [ "$2" = -q ] && [ "$3" = -a ] &&
   [ "$4" = --filter ] && [ "$5" = %q ] &&
   { [ "$#" -eq 5 ] || { [ "$6" = --filter ] && [ "$7" = %q ]; }; }; then
  printf 'ps-owned-empty\n' >>%q
  exit 0
fi
printf '%%s\n' "$@" >>%q
printf 'Unexpected Docker operation refused by component fixture\n' >&2
exit 99
`, "label=devcontainer.local_folder="+assignment.WorkspaceFolder,
		"label=devcontainer.config_file="+config, inventory, unexpected)
	if err := os.WriteFile(filepath.Join(diagnostics, "docker"), []byte(docker), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", diagnostics+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Log("Component-only lockfile regression with isolated empty Docker inventory, not native lifecycle acceptance")
	return assignment, func(cliErr error) {
		t.Helper()
		if calls, err := os.ReadFile(unexpected); err == nil {
			t.Fatalf("actual CLI attempted an unexpected Docker operation:\n%s", calls)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if cliErr != nil {
			out, _ := os.ReadFile(stdout)
			diagnostic, _ := os.ReadFile(stderr)
			t.Fatalf("actual read-configuration: %v\nactual CLI stdout:\n%s\nactual CLI stderr:\n%s", cliErr, out, diagnostic)
		}
		if calls, err := os.ReadFile(inventory); err != nil || string(calls) != "ps-owned-empty\nps-owned-empty\n" {
			t.Fatalf("actual CLI did not observe its exact-config and folder-only empty inventories: %q, %v", calls, err)
		}
	}
}

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

// These controlled CLI responses qualify the production adapter's ordering.
// Actual pinned CLI DTO and lock-write/frozen behavior are tested separately.
func TestNativeConfigurationResolvedFeaturesLockfileBeforeMergedCLI(t *testing.T) {
	for _, features := range []string{"", `,"features":null`, `,"features":{}`, `,"features":{"./owned-local-feature":{}}`} {
		t.Run(features, func(t *testing.T) {
			assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
			bin := t.TempDir()
			trace := filepath.Join(bin, "trace")
			lockfile := filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json")
			wantLock := strings.Contains(features, "./owned-local-feature")
			check := fmt.Sprintf("[ ! -e %q ] || exit 91", lockfile)
			if wantLock {
				check = fmt.Sprintf("[ \"$(stat -c '%%u:%%g:%%s' %q)\" = '1000:1000:0' ] || exit 92", lockfile)
			}
			script := fmt.Sprintf(`#!/bin/sh
[ "$1" = read-configuration ] || exit 90
case " $* " in
 *" --include-merged-configuration "*)
   %s
   printf 'merged\n' >>%q ;;
 *)
   [ ! -e %q ] || exit 93
   printf 'plain\n' >>%q ;;
esac
printf '%%s\n' %q
`, check, trace, lockfile, trace, `{"configuration":{"image":"owned-image"`+features+`},"mergedConfiguration":{}}`)
			if err := os.WriteFile(filepath.Join(bin, "devcontainer"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			if _, err := validateDevcontainerConfiguration(context.Background(), assignment, true); err != nil {
				t.Fatal(err)
			}
			if data, err := os.ReadFile(trace); err != nil || string(data) != "plain\nmerged\n" {
				t.Fatalf("merged resolution did not first observe actual plain configuration: %q, %v", data, err)
			}
		})
	}
}

func TestNativeLockfileStartupResolvesEffectiveConfigurationBeforeUp(t *testing.T) {
	for _, scenario := range []string{"featureless", "dependency-features", "prebuilt-featureless", "root-lockfile"} {
		t.Run(scenario, func(t *testing.T) {
			assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
			assignment.RuntimeAttemptID, assignment.Generation, assignment.ComposeProjectName = "owned-lockfile", 3, "owned-lockfile"
			bin := t.TempDir()
			trace := filepath.Join(bin, "trace")
			lockfile := filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json")
			config := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
			authored := `{"image":"owned-image"}`
			recipe := `{"image":"owned-image"}`
			if scenario == "dependency-features" {
				recipe = `{"image":"owned-dependency-image","features":{"./owned-local-feature":{}}}`
			}
			effectivePath := config
			if scenario == "dependency-features" || scenario == "prebuilt-featureless" {
				assignment.EffectiveConfiguration = filepath.Join(bin, "effective.json")
				effectivePath = assignment.EffectiveConfiguration
				if err := os.WriteFile(effectivePath, []byte(recipe), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "prebuilt-featureless" {
				authored = `{"image":"owned-image","features":{"./authored-feature":{}}}`
			}
			if err := os.WriteFile(config, []byte(authored), 0600); err != nil {
				t.Fatal(err)
			}
			wantLock := scenario == "dependency-features"
			check := fmt.Sprintf("[ ! -e %q ] || exit 91", lockfile)
			if wantLock {
				check = fmt.Sprintf("[ \"$(stat -c '%%u:%%g:%%s' %q)\" = '1000:1000:0' ] || exit 92\nprintf 'owned-populated-feature-lock\\n' >%q", lockfile, lockfile)
			}
			readArgs := "read-configuration --workspace-folder " + assignment.WorkspaceFolder + " --config " + config + " --log-format json"
			if assignment.EffectiveConfiguration != "" {
				readArgs += " --override-config " + assignment.EffectiveConfiguration
			}
			readArgs += " --id-label " + attemptLabel + "=owned-lockfile --id-label " + generationLabel + "=3"
			upArgs := "up --workspace-folder " + assignment.WorkspaceFolder + " --config " + config +
				" --log-format text --update-remote-user-uid-default never --id-label " + attemptLabel +
				"=owned-lockfile --id-label " + generationLabel + "=3"
			if assignment.EffectiveConfiguration != "" {
				upArgs += " --override-config " + assignment.EffectiveConfiguration
			}
			upArgs += " --skip-post-create"
			script := fmt.Sprintf(`#!/bin/sh
if [ "$*" = %q ]; then
  [ ! -e %q ] || exit 93
  printf 'read-effective\n' >>%q
  printf '{"configuration":%%s}\n' "$(cat %q)"
elif [ "$*" = %q ]; then
  %s
  printf 'up-fenced\n' >>%q
  printf 'owned-component-stop-before-lifecycle\n' >&2
  exit 47
else
  printf 'unexpected-cli\n' >>%q
  exit 99
fi
`, readArgs, lockfile, trace, effectivePath, upArgs, check, trace, trace)
			psArgs := "ps -aq --no-trunc --filter label=com.docker.compose.project=owned-lockfile --filter label=" + attemptLabel
			docker := fmt.Sprintf("#!/bin/sh\n[ \"$*\" = %q ] || exit 99\nprintf 'empty-inventory\\n' >>%q\n", psArgs, trace)
			for name, content := range map[string]string{"devcontainer": script, "docker": docker} {
				if err := os.WriteFile(filepath.Join(bin, name), []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			if scenario == "root-lockfile" {
				if os.Geteuid() != 0 {
					t.Skip("requires owned root fixture")
				}
				if err := os.WriteFile(lockfile, []byte("retained-root-lockfile"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			// Invoke the normal production wrapper, not its portable test seam.
			// The controlled CLI stops before Docker creation or any user hook.
			_, err := startDevcontainer(context.Background(), assignment)
			if scenario == "root-lockfile" {
				if !errors.Is(err, errDevcontainerNotStarted) || !strings.Contains(err.Error(), "existing metadata retained") {
					t.Fatalf("up did not refuse retained root metadata: %v", err)
				}
				if data, err := os.ReadFile(trace); err != nil || string(data) != "empty-inventory\n" {
					t.Fatalf("root lockfile reached a CLI call: %q, %v", data, err)
				}
				if data, err := os.ReadFile(lockfile); err != nil || string(data) != "retained-root-lockfile" {
					t.Fatal("up changed retained root metadata")
				}
				return
			}
			var exitError *exec.ExitError
			if !errors.As(err, &exitError) || exitError.ExitCode() != 47 {
				t.Fatalf("up did not reach its ownership-fenced boundary: %v", err)
			}
			if data, err := os.ReadFile(trace); err != nil || string(data) != "empty-inventory\nread-effective\nup-fenced\n" {
				t.Fatalf("effective configuration was not re-read directly before up: %q, %v", data, err)
			}
			if data, err := os.ReadFile(config); err != nil || string(data) != authored {
				t.Fatal("startup changed authored configuration instead of using the effective DTO")
			}
			if wantLock {
				var stat unix.Stat_t
				if err := unix.Lstat(lockfile, &stat); err != nil || stat.Uid != 1000 || stat.Gid != 1000 {
					t.Fatalf("up lost Feature lockfile ownership: %v", err)
				}
				if data, err := os.ReadFile(lockfile); err != nil || string(data) != "owned-populated-feature-lock\n" {
					t.Fatal("up lost populated Feature metadata on command failure")
				}
			} else if _, err := os.Lstat(lockfile); !os.IsNotExist(err) {
				t.Fatalf("featureless effective up created metadata: %v", err)
			}
		})
	}
}

func TestNativeLockfileFeaturelessConfigurationFailureLeavesNoReservation(t *testing.T) {
	for _, failure := range []string{"command", "invalid-json", "cancelled"} {
		t.Run(failure, func(t *testing.T) {
			assignment := nativeLockfileFixture(t, ".devcontainer/devcontainer.json")
			bin := t.TempDir()
			script := "#!/bin/sh\nexit 48\n"
			if failure == "invalid-json" {
				script = "#!/bin/sh\nprintf 'not-configuration\\n'\n"
			}
			if err := os.WriteFile(filepath.Join(bin, "devcontainer"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if failure == "cancelled" {
				cancel()
			}
			if _, err := validateDevcontainerConfiguration(ctx, assignment, false); err == nil {
				t.Fatal("failed configuration was accepted")
			}
			if _, err := os.Lstat(filepath.Join(assignment.WorkspaceFolder, ".devcontainer/devcontainer-lock.json")); !os.IsNotExist(err) {
				t.Fatalf("failed/cancelled featureless configuration left an inode: %v", err)
			}
		})
	}
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
