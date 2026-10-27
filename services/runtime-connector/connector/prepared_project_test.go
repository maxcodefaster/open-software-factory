package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func preparedFixture(t *testing.T) (ReserveSlot, ReserveActivation) {
	t.Helper()
	slot, activation, _ := reserveFixture(t)
	source := activation.Assignment
	source.RuntimeAttemptID = slot.ID
	source.Generation = 1
	source.ControlURL = "ws://unassigned.invalid/"
	source.Processes = []Process{{Name: "app", Command: []string{"node", "server.js"}}}
	slot.Project = &source
	activation.TemplateID = slot.ID
	activation.SlotID = "9c2ee2af-1e7a-4a46-882d-bc1497508468"
	activation.Assignment.Processes = source.Processes
	return slot, activation
}

func TestPreparedRecipeHasNoRuntimeGrantsOrExecutionTools(t *testing.T) {
	slot, activation := preparedFixture(t)
	if err := validateReserveSlot(slot); err != nil {
		t.Fatal(err)
	}
	if err := validateReserveActivation(slot, activation); err != nil {
		t.Fatal(err)
	}
	version := uint64(1)
	for _, mutate := range []func(*Assignment){
		func(a *Assignment) { a.EnvironmentVersion = &version },
		func(a *Assignment) { a.RuntimeEnvironment = map[string]string{"SECRET": "private"} },
		func(a *Assignment) { a.PreserveWorkspace = true },
		func(a *Assignment) { a.EnvironmentSecretsFile = "/run/secret" },
		func(a *Assignment) { a.DockerConfigDirectory = "/run/registry" },
		func(a *Assignment) { a.RegistryCAFile = "/run/trust" },
		func(a *Assignment) { a.Channels = []Channel{{Name: "ide", Kind: "ide"}} },
		func(a *Assignment) {
			a.Channels = []Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:4300"}}
		},
		func(a *Assignment) { a.ControlURL = "ws://factory.invalid/internal/runtime-connect" },
	} {
		slot, _ := preparedFixture(t)
		mutate(slot.Project)
		if validateReserveSlot(slot) == nil {
			t.Fatal("prepared capture accepted Runtime grants or tools")
		}
	}
}

func TestPreparedAssignmentBindsForkAndProjectBeforeDeliveringCapabilities(t *testing.T) {
	for _, mutate := range []func(*ReserveActivation){
		func(a *ReserveActivation) { a.TemplateID = "foreign-template" },
		func(a *ReserveActivation) { a.SlotID = a.TemplateID },
		func(a *ReserveActivation) { a.Assignment.RepositoryIdentity = "foreign-project" },
		func(a *ReserveActivation) { a.Assignment.PreserveWorkspace = true },
		func(a *ReserveActivation) { a.Assignment.Channels[0].Kind = "agent" },
	} {
		slot, activation := preparedFixture(t)
		mutate(&activation)
		if validateReserveActivation(slot, activation) == nil {
			t.Fatal("prepared fork accepted another owner or role")
		}
	}
}

func TestPreparedProcessesCanOnlyAdoptExactSourceAndFreshRuntimeAuthority(t *testing.T) {
	slot, activation := preparedFixture(t)
	source := *slot.Project
	source.WorkspaceFolder = source.RemoteWorkspaceFolder
	target := activation.Assignment
	target.WorkspaceFolder = target.RemoteWorkspaceFolder
	request := preparedChildRequest{Action: "activate", Assignment: target, Token: "fresh-target-token"}
	if err := validatePreparedChildActivation(source, request); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*preparedChildRequest){
		func(r *preparedChildRequest) { r.Token = "" },
		func(r *preparedChildRequest) { r.Assignment.RuntimeAttemptID = source.RuntimeAttemptID },
		func(r *preparedChildRequest) { r.Assignment.RepositoryIdentity = "foreign-project" },
		func(r *preparedChildRequest) { r.Assignment.Revision = strings.Repeat("b", 40) },
		func(r *preparedChildRequest) { r.Assignment.DevcontainerPath = ".devcontainer/other.json" },
		func(r *preparedChildRequest) {
			r.Assignment.RuntimeEnvironment = map[string]string{"SECRET": "private"}
		},
		func(r *preparedChildRequest) {
			r.Assignment.Processes = []Process{{Name: "app", Command: []string{"other"}}}
		},
	} {
		candidate := request
		mutate(&candidate)
		if validatePreparedChildActivation(source, candidate) == nil {
			t.Fatal("prepared process adoption replaced its immutable source or copied Runtime grants")
		}
	}
}

func TestPreparedPrivateInputIsBoundedAndExact(t *testing.T) {
	request := preparedChildRequest{Action: "status"}
	content, _ := json.Marshal(request)
	if _, err := readPreparedChildRequest(bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	for _, malformed := range [][]byte{
		append(append([]byte{}, content...), []byte("{}")...),
		[]byte(`{"action":"status","unknown":true}`),
		bytes.Repeat([]byte(" "), 1024*1024+1),
	} {
		if _, err := readPreparedChildRequest(bytes.NewReader(malformed)); err == nil {
			t.Fatal("unbounded or ambiguous private activation was accepted")
		}
	}
}

func TestPreparedComposeCleanupUsesImmutableContainerOrigin(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "commands")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
if [ "$1" = inspect ]; then
  printf '%s\n' '[{"Id":"primary","Config":{"Labels":{"factory.dev/runtime-attempt":"template","factory.dev/runtime-generation":"1","com.docker.compose.project":"template_compose"}}}]'
fi
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_DOCKER_LOG", logPath)
	if err := cleanupProject(parentState{
		RuntimeAttemptID: "assigned", Generation: 7, ContainerID: "primary",
		ComposeProjectName: "assigned_compose",
		ContainerOrigin:    &containerOrigin{"template", 1, "template_compose"},
	}); err != nil {
		t.Fatal(err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(commands), "label=com.docker.compose.project=template_compose") != 3 ||
		strings.Contains(string(commands), "assigned_compose") {
		t.Fatalf("prepared cleanup lost its original Compose ownership: %s", commands)
	}
}

func TestPreparedChildPublicRecipeIsReadableWithoutDeliveringRuntimeCredentials(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "commands")
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FACTORY_DOCKER_LOG\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_DOCKER_LOG", logPath)
	slot, _ := preparedFixture(t)
	exited, err := injectPreparedChild(context.Background(), *slot.Project, devcontainerResult{
		ContainerID: "owned-primary", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := <-exited; err != nil {
		t.Fatal(err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(commands), `chmod 0444 "$2"`) {
		t.Fatalf("the non-root prepared child cannot read its root-owned public recipe: %s", commands)
	}
	if strings.Contains(string(commands), "--token") || strings.Contains(string(commands), "parent-token") ||
		strings.Contains(string(commands), "child-token") {
		t.Fatal("prepared capture delivered Runtime credentials")
	}
}

func TestPreparedStandaloneCleanupNeverSelectsAnEmptyComposeOwner(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "commands")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_DOCKER_LOG"
if [ "$1" = inspect ]; then
  printf '%s\n' '[{"Id":"primary","Config":{"Labels":{"factory.dev/runtime-attempt":"template","factory.dev/runtime-generation":"1"}}}]'
fi
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_DOCKER_LOG", logPath)
	if err := cleanupProject(parentState{
		RuntimeAttemptID: "assigned", Generation: 7, ContainerID: "primary",
		ComposeProjectName: "assigned_compose", ContainerOrigin: &containerOrigin{"template", 1, ""},
	}); err != nil {
		t.Fatal(err)
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(commands) != "inspect primary\nrm -f primary\n" {
		t.Fatalf("standalone cleanup addressed resources outside its exact primary: %s", commands)
	}
}
