package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeEnvironmentAuthenticationVersionAndSanitizedFailures(t *testing.T) {
	version := uint64(3)
	assignment := validAssignment()
	assignment.EnvironmentVersion = &version
	scenario := "valid"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/runtime-environment/"+assignment.RuntimeAttemptID || r.Header.Get("Authorization") != "Bearer owned-parent-token" || r.Header.Get("X-Factory-Runtime-Generation") != "1" {
			t.Error("credentials not scoped to assignment")
		}
		if scenario == "denied" {
			w.WriteHeader(403)
			w.Write([]byte("secret-do-not-disclose"))
			return
		}
		response := runtimeEnvironment{Version: version, Bundle: environmentBundle{Variables: []environmentVariable{{Name: "API_KEY", Value: "owned-secret", Runtime: true}}}}
		if scenario == "stale" {
			response.Version = 2
		}
		if scenario == "reserved" {
			response.Bundle.Variables[0].Name = "DOCKER_HOST"
		}
		json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()
	assignment.ControlURL = strings.Replace(server.URL, "http://", "ws://", 1) + "/internal/runtime-connect"
	for _, value := range []string{"valid", "denied", "stale", "reserved"} {
		scenario = value
		result, err := readRuntimeEnvironment(context.Background(), assignment, "owned-parent-token")
		if (err == nil) != (value == "valid") {
			t.Fatalf("%s: %v", value, err)
		}
		if err != nil && strings.Contains(err.Error(), "secret-do-not-disclose") {
			t.Fatal("secret error leaked")
		}
		if err == nil && result.Bundle.Variables[0].Value != "owned-secret" {
			t.Fatal("missing runtime value")
		}
	}
}

func TestEnvironmentFilesArePrivateRecoverableAndNeverAssignmentMetadata(t *testing.T) {
	root := t.TempDir()
	build := filepath.Join(root, "factory-build-secrets")
	environment := runtimeEnvironment{Version: 1, Bundle: environmentBundle{Variables: []environmentVariable{
		{Name: "APP_TOKEN", Value: "owned-runtime\nvalue", Runtime: true},
		{Name: "BUILD_TOKEN", Value: "owned-build-only", Build: true},
	}}}
	files, err := prepareEnvironmentFilesAt(environment, root, build)
	if err != nil {
		t.Fatal(err)
	}
	defer files.cleanup()
	for _, path := range []string{files.secretsFile, filepath.Join(build, "BUILD_TOKEN"), filepath.Join(files.dockerConfig, "config.json")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("secret file permissions differ")
		}
	}
	content, err := os.ReadFile(files.secretsFile)
	if err != nil || !strings.Contains(string(content), "APP_TOKEN") || strings.Contains(string(content), "BUILD_TOKEN") {
		t.Fatal("hook secret grants differ")
	}
	if _, err := prepareEnvironmentFilesAt(environment, root, build); err == nil {
		t.Fatal("concurrent owner admitted")
	}
	assignment := validAssignment()
	assignment.RuntimeEnvironment = map[string]string{"APP_TOKEN": "owned-runtime"}
	assignment.EnvironmentSecretsFile = files.secretsFile
	encoded, _ := json.Marshal(assignment)
	if strings.Contains(string(encoded), "owned-runtime") || strings.Contains(string(encoded), files.secretsFile) {
		t.Fatal("secret serialized into assignment")
	}
	// Model SIGKILL: release the OS lock, retain the memory files and pointer.
	files.lock.Close()
	files.lock = nil
	recovered, err := prepareEnvironmentFilesAt(environment, root, build)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(files.directory); !os.IsNotExist(err) {
		t.Fatal("interrupted values retained")
	}
	recovered.cleanup()
	if _, err := os.Lstat(build); !os.IsNotExist(err) {
		t.Fatal("build pointer retained after cleanup")
	}
	if err := os.Mkdir(build, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareEnvironmentFilesAt(environment, root, build); err == nil {
		t.Fatal("unknown directory overwritten")
	}
}

func TestChildRuntimeEnvironmentRejectsInfrastructureOverrides(t *testing.T) {
	for _, name := range []string{"DOCKER_CONFIG", "FACTORY_TOKEN", "HOME", "NODE_OPTIONS", "../PATH"} {
		if ValidateRuntimeValues(map[string]string{name: "owned"}) == nil {
			t.Fatal("reserved child value admitted")
		}
	}
	if ValidateRuntimeValues(map[string]string{"APP_TOKEN": "owned\nvalue"}) != nil {
		t.Fatal("multiline value rejected")
	}
}

func TestEnvironmentFilesRecoverAfterColdRestartLosesMemoryStorage(t *testing.T) {
	root := t.TempDir()
	memory := filepath.Join(root, "memory")
	if err := os.Mkdir(memory, 0700); err != nil {
		t.Fatal(err)
	}
	build := filepath.Join(root, "factory-build-secrets")
	environment := runtimeEnvironment{Version: 1, Bundle: environmentBundle{Variables: []environmentVariable{
		{Name: "APP_TOKEN", Value: "owned-runtime", Runtime: true},
		{Name: "BUILD_TOKEN", Value: "owned-build", Build: true},
	}}}
	files, err := prepareEnvironmentFilesAt(environment, memory, build)
	if err != nil {
		t.Fatal(err)
	}
	defer files.cleanup()
	// ROOTFS restarts processes and the memory mount, but retains /run's
	// build pointer. Replay exactly the state captured from native restore:
	// an unlocked private lock and a symlink whose memory directory is absent.
	if err := files.lock.Close(); err != nil {
		t.Fatal(err)
	}
	files.lock = nil
	if err := os.RemoveAll(files.directory); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(build); err != nil {
		t.Fatal("cold restart must retain the build pointer", err)
	}
	if _, err := os.Lstat(files.directory); !os.IsNotExist(err) {
		t.Fatal("cold restart must lose the memory directory", err)
	}
	restored, err := prepareEnvironmentFilesAt(environment, memory, build)
	if err != nil {
		t.Fatalf("cold runtime environment preparation failed: %v", err)
	}
	defer restored.cleanup()
	if restored.directory == files.directory {
		t.Fatal("cold restart reused an old secret directory")
	}
	for path, expected := range map[string]string{
		restored.secretsFile:                `{"APP_TOKEN":"owned-runtime"}`,
		filepath.Join(build, "BUILD_TOKEN"): "owned-build",
	} {
		content, err := os.ReadFile(path)
		if err != nil || string(content) != expected {
			t.Fatal("authenticated environment was not rematerialized")
		}
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("cold recovery widened secret permissions")
		}
	}
}

func TestEnvironmentFilesColdRecoveryKeepsExclusiveLock(t *testing.T) {
	root := t.TempDir()
	build := filepath.Join(root, "factory-build-secrets")
	files, err := prepareEnvironmentFilesAt(runtimeEnvironment{}, root, build)
	if err != nil {
		t.Fatal(err)
	}
	defer files.cleanup()
	if err := os.RemoveAll(files.directory); err != nil {
		t.Fatal(err)
	}
	_, err = prepareEnvironmentFilesAt(runtimeEnvironment{}, root, build)
	if err == nil || err.Error() != "Build secret storage is already in use" {
		t.Fatalf("live owner was not fenced: %v", err)
	}
	if target, err := os.Readlink(build); err != nil || target != filepath.Join(files.directory, "build") {
		t.Fatal("concurrent recovery changed the live owner's pointer")
	}
}

func TestEnvironmentFilesColdRecoveryRejectsUnconfirmedPointers(t *testing.T) {
	for _, scenario := range []string{"outside-memory", "wrong-prefix", "wrong-leaf", "unclean-target", "root-symlink", "public-root", "regular-pointer", "lock-symlink"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			memory := filepath.Join(root, "memory")
			if err := os.Mkdir(memory, 0700); err != nil {
				t.Fatal(err)
			}
			build := filepath.Join(root, "factory-build-secrets")
			oldRoot := filepath.Join(memory, "factory-environment-1234")
			target := filepath.Join(oldRoot, "build")
			switch scenario {
			case "outside-memory":
				target = filepath.Join(root, "factory-environment-1234", "build")
			case "wrong-prefix":
				target = filepath.Join(memory, "foreign-1234", "build")
			case "wrong-leaf":
				target = filepath.Join(oldRoot, "foreign")
			case "unclean-target":
				target = oldRoot + "/../factory-environment-5678/build"
			case "root-symlink":
				if err := os.Symlink(root, oldRoot); err != nil {
					t.Fatal(err)
				}
			case "public-root":
				if err := os.Mkdir(oldRoot, 0755); err != nil {
					t.Fatal(err)
				}
			case "regular-pointer":
				if err := os.WriteFile(build, []byte("not ours"), 0600); err != nil {
					t.Fatal(err)
				}
			case "lock-symlink":
				if err := os.Symlink(filepath.Join(root, "foreign-lock"), build+".lock"); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "regular-pointer" {
				if err := os.Symlink(target, build); err != nil {
					t.Fatal(err)
				}
			}
			if files, err := prepareEnvironmentFilesAt(runtimeEnvironment{}, memory, build); err == nil {
				files.cleanup()
				t.Fatal("unconfirmed pointer accepted")
			}
			if _, err := os.Lstat(build); err != nil {
				t.Fatal("rejected recovery changed the unconfirmed pointer", err)
			}
		})
	}
}

func TestEnvironmentFilesRecoveryRejectsForeignOwners(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	for _, scenario := range []string{"foreign-pointer-missing-root", "foreign-pointer-present-root", "foreign-root"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			build := filepath.Join(root, "factory-build-secrets")
			previous := filepath.Join(root, "factory-environment-1234")
			if scenario != "foreign-pointer-missing-root" {
				if err := os.Mkdir(previous, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(filepath.Join(previous, "build"), build); err != nil {
				t.Fatal(err)
			}
			path := build
			if scenario == "foreign-root" {
				path = previous
			}
			if err := os.Lchown(path, 1000, 1000); err != nil {
				t.Fatal(err)
			}
			if files, err := prepareEnvironmentFilesAt(runtimeEnvironment{}, root, build); err == nil {
				files.cleanup()
				t.Fatal("foreign ownership accepted")
			}
			if _, err := os.Lstat(build); err != nil {
				t.Fatal("rejected recovery changed the foreign pointer")
			}
		})
	}
}

func TestAssignedEnvironmentReplacesInheritedValues(t *testing.T) {
	result := assignedEnvironment([]string{"API_KEY=old", "HOME=/home/node"}, map[string]string{"API_KEY": "new\nvalue"})
	if len(result) != 2 || result[0] != "HOME=/home/node" || result[1] != "API_KEY=new\nvalue" {
		t.Fatalf("unexpected env %v", result)
	}
}

func TestComposeAndDevcontainerReceiveOnlyAssignedRuntimeValues(t *testing.T) {
	assignment := Assignment{RuntimeEnvironment: map[string]string{"POSTGRES_PASSWORD": "owned-value", "DATABASE_URL": "owned-url"}, DockerConfigDirectory: "/owned/docker", RegistryCAFile: "/owned/ca"}
	environment := strings.Join(devcontainerEnvironment(assignment), "\n")
	for _, expected := range []string{"POSTGRES_PASSWORD=owned-value", "DATABASE_URL=owned-url", "DOCKER_CONFIG=/owned/docker", "NODE_EXTRA_CA_CERTS=/owned/ca"} {
		if !strings.Contains(environment, expected) {
			t.Fatal("missing assigned development value")
		}
	}
	ctx := context.WithValue(context.Background(), runtimeVariablesContextKey{}, assignment.RuntimeEnvironment)
	ctx = context.WithValue(ctx, dockerConfigContextKey{}, assignment.DockerConfigDirectory)
	command := runtimeDockerCommand(ctx, "compose", "config")
	if !strings.Contains(strings.Join(command.Env, "\n"), "POSTGRES_PASSWORD=owned-value") {
		t.Fatal("Compose cannot resolve assigned environment")
	}
}

func TestNativeComposeIdentityOverridesInheritedAndProjectValuesOnlyForNativeCLI(t *testing.T) {
	t.Setenv("COMPOSE_PROJECT_NAME", "inherited-project")
	assignment := validAssignment()
	assignment.RuntimeEnvironment = map[string]string{"COMPOSE_PROJECT_NAME": "project-grant"}
	if !strings.Contains(strings.Join(devcontainerEnvironment(assignment), "\n"), "COMPOSE_PROJECT_NAME=project-grant") {
		t.Fatal("ordinary CLI environment behavior changed")
	}
	assignment.nativeActorUID = "original-native-actor"
	environment := strings.Join(devcontainerEnvironment(assignment), "\n")
	if !strings.Contains(environment, "COMPOSE_PROJECT_NAME="+assignment.ComposeProjectName) || strings.Contains(environment, "COMPOSE_PROJECT_NAME=project-grant") || strings.Contains(environment, "COMPOSE_PROJECT_NAME=inherited-project") {
		t.Fatal("native CLI can start a different Compose owner than its immutable assignment")
	}
	if assignment.RuntimeEnvironment["COMPOSE_PROJECT_NAME"] != "project-grant" {
		t.Fatal("native selection changed the saved Project environment")
	}
}

func TestCredentialFreeCommandsRetainAdmittedFactoryRegistryTrust(t *testing.T) {
	t.Setenv("NODE_EXTRA_CA_CERTS", "/foreign/inherited-ca")
	slot, _ := preparedFixture(t)
	if err := validatePreparedProject(*slot.Project); err != nil {
		t.Fatal(err)
	}
	for _, environment := range [][]string{
		devcontainerEnvironment(*slot.Project),
		prebuildCommand(context.Background(), "/tmp", "node", "--version").Env,
	} {
		count := 0
		for _, variable := range environment {
			if strings.HasPrefix(variable, "NODE_EXTRA_CA_CERTS=") {
				count++
				if variable != "NODE_EXTRA_CA_CERTS=/factory/registry-ca/ca.crt" {
					t.Fatal("credential-free CLI lost its admitted public Registry trust")
				}
			}
		}
		if count != 1 {
			t.Fatal("credential-free CLI requires exactly one admitted Registry CA bundle")
		}
	}
}

func TestProjectRegistryTrustOverridesPublicDefaultWithoutDockerCredentials(t *testing.T) {
	environment := devcontainerEnvironment(Assignment{RegistryCAFile: "/owned/combined-ca"})
	if !strings.Contains(strings.Join(environment, "\n"), "NODE_EXTRA_CA_CERTS=/owned/combined-ca") {
		t.Fatal("CLI trust incorrectly depends on Docker credential configuration")
	}
	ctx := context.WithValue(context.Background(), registryCAContextKey{}, "/owned/combined-ca")
	command := prebuildCommand(ctx, "/tmp", "node", "--version")
	if !strings.Contains(strings.Join(command.Env, "\n"), "NODE_EXTRA_CA_CERTS=/owned/combined-ca") {
		t.Fatal("prebuild command discarded the combined admitted Registry trust")
	}
}
