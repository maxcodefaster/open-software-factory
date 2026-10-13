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
