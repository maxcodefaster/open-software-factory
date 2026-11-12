package connector

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func nativePrebuildTransportFixture(t *testing.T, assignment Assignment) {
	t.Helper()
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	t.Setenv("DOCKER_HOST", "unix:///run/user/1000/docker.sock")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:8888")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:8888")
}

func TestPrebuildNativeProxyRequiresTheVerifiedAssignmentAndNeverExportsPrivateEnvironment(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeActorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	nativePrebuildTransportFixture(t, assignment)
	t.Setenv("FACTORY_PARENT_CONNECTOR_TOKEN", "private-parent-fixture")
	t.Setenv("PRIVATE_RUNTIME_ONLY", "private-runtime-fixture")
	ctx, err := nativePrebuildContext(context.Background(), Assignment{})
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.Join(prebuildCommand(ctx, t.TempDir(), "true").Env, "\n")
	if strings.Contains(legacy, "PROXY=") || strings.Contains(legacy, "private-") {
		t.Fatal("an environment variable alone enabled native transport or exported credentials")
	}
	ctx, err = nativePrebuildContext(context.Background(), assignment)
	if err != nil {
		t.Fatal(err)
	}
	selected := strings.Join(prebuildCommand(ctx, t.TempDir(), "true").Env, "\n")
	if !strings.Contains(selected, "DOCKER_HOST=unix:///run/user/1000/docker.sock") || !strings.Contains(selected, "HTTPS_PROXY=http://127.0.0.1:8888") || !strings.Contains(selected, "NO_PROXY=localhost,127.0.0.1") || strings.Contains(selected, "private-") {
		t.Fatal("native build lost its private proxy or acquired private credentials")
	}
	t.Setenv("HTTP_PROXY", "http://another-host:8888")
	if _, err := nativePrebuildContext(context.Background(), assignment); err == nil {
		t.Fatal("native prebuild admitted a different proxy")
	}
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:8888")
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "another-actor")
	if _, err := nativePrebuildContext(context.Background(), assignment); err == nil {
		t.Fatal("native prebuild admitted a changed Actor identity")
	}
}

func TestNativePrebuildRecipeHashesPublicTransportButNeverPrivateImageOrActorFacts(t *testing.T) {
	input := prebuildInput{Version: 3, NativeTransportSHA256: strings.Repeat("a", 64),
		nativeBase: &nativePrebuildBase{assignment: Assignment{RuntimeAttemptID: "private-attempt"}, reference: "private-local-reference"}}
	before := prebuildIdentity(input)
	encoded, err := json.Marshal(input)
	if err != nil || strings.Contains(string(encoded), "private-") {
		t.Fatal("private native base facts entered the portable recipe")
	}
	input.nativeBase.assignment.RuntimeAttemptID = "another-attempt"
	input.nativeBase.reference = "another-local-reference"
	if prebuildIdentity(input) != before {
		t.Fatal("another admitted Actor cannot match the same public recipe")
	}
	input.NativeTransportSHA256 = strings.Repeat("b", 64)
	if prebuildIdentity(input) == before {
		t.Fatal("changed public transport inherited an earlier artifact")
	}
	var authored prebuildConfiguration
	if json.Unmarshal([]byte(`{"nativeBase":{"reference":"foreign-reference"}}`), &authored) != nil || authored.nativeBase != nil {
		t.Fatal("Source enabled the private native base capability")
	}
}
