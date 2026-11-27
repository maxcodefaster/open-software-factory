package connector

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAssignmentOmitsPrivateRuntimeEnvironmentFromSavedMetadata(t *testing.T) {
	assignment := validAssignment()
	assignment.RuntimeEnvironment = map[string]string{"APP_TOKEN": "owned-secret\nvalue"}
	encoded, err := json.Marshal(assignment)
	if err != nil || strings.Contains(string(encoded), "owned-secret") || strings.Contains(string(encoded), "APP_TOKEN") {
		t.Fatal("Runtime values entered saved assignment metadata")
	}
}

func TestSourceGitKeepsPublicTrustWithoutCredentialLeaks(t *testing.T) {
	t.Setenv("GIT_SSL_CAINFO", "/owned/admitted-ca")
	t.Setenv("GIT_SSL_NO_VERIFY", "true")
	t.Setenv("DOCKER_AUTH_CONFIG", "private-registry-credentials")
	t.Setenv("FACTORY_CONNECTOR_TOKEN", "private-parent-capability")
	command := hardenedGitCommand(t.Context(), "", nil, "ls-remote", "https://forge.factory/project.git")
	environment := strings.Join(command.Env, "\n")
	if !strings.Contains(environment, "GIT_SSL_CAINFO=/owned/admitted-ca") {
		t.Fatal("Source Git discarded admitted public trust")
	}
	for _, forbidden := range []string{"GIT_SSL_NO_VERIFY=", "DOCKER_AUTH_CONFIG=", "FACTORY_CONNECTOR_TOKEN=", "private-"} {
		if strings.Contains(environment, forbidden) {
			t.Fatalf("Source Git inherited unrelated credentials or a TLS bypass: %s", forbidden)
		}
	}
}
