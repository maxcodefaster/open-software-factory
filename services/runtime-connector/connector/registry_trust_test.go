package connector

import (
	"context"
	"strings"
	"testing"
)

func TestRegistryTrustUsesTheVerifiedRootlessDaemonConfigHome(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeActorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
	t.Setenv("HOME", "/home/rootless")
	t.Setenv("XDG_CONFIG_HOME", "")
	path, err := registryCertificateDirectory(assignment, "registry.factory")
	if err != nil || path != "/home/rootless/.config/docker/certs.d/registry.factory" {
		t.Fatalf("rootless daemon would not see its admitted registry CA: %s: %v", path, err)
	}
	path, err = registryCertificateDirectory(Assignment{}, "registry.factory")
	if err != nil || path != "/etc/docker/certs.d/registry.factory" {
		t.Fatal("ambient native variables changed another daemon's trust path")
	}
	t.Setenv("XDG_CONFIG_HOME", "/another/home")
	if _, err := registryCertificateDirectory(assignment, "registry.factory"); err == nil {
		t.Fatal("changed daemon config home was accepted")
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "another-actor")
	if _, err := registryCertificateDirectory(assignment, "registry.factory"); err == nil {
		t.Fatal("changed Actor authority was accepted")
	}
}

func TestPrebuildPublicationKeepsItsPrivateDaemonTransport(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeActorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	nativePrebuildTransportFixture(t, assignment)
	ctx, err := nativePrebuildContext(context.Background(), assignment)
	if err != nil {
		t.Fatal(err)
	}
	command := prebuildCommand(ctx, t.TempDir(), "docker", "push", "registry.factory/prebuilds/project:owned")
	environment := strings.Join(command.Env, "\n")
	if !strings.Contains(environment, "DOCKER_HOST=unix:///run/user/1000/docker.sock") || !strings.Contains(environment, "HTTPS_PROXY=http://127.0.0.1:8888") {
		t.Fatal("publication lost its exact Actor-private Docker/proxy transport")
	}
}
