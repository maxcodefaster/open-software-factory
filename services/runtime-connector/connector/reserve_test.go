package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func reserveFixture(t *testing.T) (ReserveSlot, ReserveActivation, string) {
	t.Helper()
	directory := t.TempDir()
	slot := ReserveSlot{Version: 1, ID: "ec253fc1-4e17-4a75-a36d-c4efef02e77e", Role: "staging", ExpiresAt: time.Now().Add(time.Minute)}
	activation := ReserveActivation{SlotID: slot.ID, PodUID: "exact-pod", ParentToken: "parent", ChildToken: "child", Assignment: Assignment{Version: 1, RuntimeAttemptID: "01234567-89ab-5def-8123-456789abcdef", Generation: 1, WorkspaceFolder: "/home/coder/project", RemoteWorkspaceFolder: "/workspace/project", ConnectorStateDir: "/home/coder/connector-state", RepositoryURL: "https://forge.invalid/owned/project.git", RepositoryIdentity: "owned-project", Revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DevcontainerPath: ".devcontainer/devcontainer.json", ComposeProjectName: "project_devcontainer", ControlURL: "ws://factory.invalid/internal/runtime-connect", Channels: []Channel{{Name: "app", Kind: "app", Target: "http://127.0.0.1:4300", HealthPath: "/health"}}}}
	return slot, activation, filepath.Join(directory, "activation.json")
}

func TestReserveActivationCannotAcquireRetainedSourceOrDifferentRole(t *testing.T) {
	slot, activation, _ := reserveFixture(t)
	if err := validateReserveActivation(slot, activation); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*ReserveActivation){
		func(a *ReserveActivation) { a.SlotID = "other-slot" },
		func(a *ReserveActivation) { a.Assignment.PreserveWorkspace = true },
		func(a *ReserveActivation) { a.Assignment.WorkspaceFolder = "/home/coder/other" },
		func(a *ReserveActivation) { a.Assignment.Channels[0].Kind = "agent" },
		func(a *ReserveActivation) { a.ParentToken = "" },
	} {
		_, copy, _ := reserveFixture(t)
		mutate(&copy)
		if validateReserveActivation(slot, copy) == nil {
			t.Fatal("unsafe slot activation accepted")
		}
	}
}

func TestReserveActivationPersistsExactOwnerAndRecoversOnlySameInput(t *testing.T) {
	slot, activation, path := reserveFixture(t)
	content, _ := json.Marshal(activation)
	if err := os.WriteFile(path, content, 0400); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "ready"), []byte(slot.ID), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := acceptReserveActivation(slot, path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "ready")); !os.IsNotExist(err) {
		t.Fatal("used slot still advertised ready")
	}
	if _, err := acceptReserveActivation(slot, path); err != nil {
		t.Fatal("same-input recovery failed", err)
	}
	var outcome reserveOutcome
	if _, err := readReserveJSON(filepath.Join(filepath.Dir(path), "activated.json"), &outcome); err != nil {
		t.Fatal(err)
	}
	if outcome.AttemptID != activation.Assignment.RuntimeAttemptID || outcome.PodUID != activation.PodUID {
		t.Fatal("wrong exact slot owner")
	}
	activation.Assignment.RuntimeAttemptID = "different-attempt"
	content, _ = json.Marshal(activation)
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := acceptReserveActivation(slot, path); err == nil {
		t.Fatal("used slot accepted another attempt")
	}
}

func TestReservePreparationRejectsMutableImagesAndUnboundedInput(t *testing.T) {
	slot, activation, path := reserveFixture(t)
	slot.Images = []string{"node:latest"}
	if validateReserveSlot(slot) == nil {
		t.Fatal("mutable reserve image accepted")
	}
	content, _ := json.Marshal(activation)
	if err := os.WriteFile(path, append(content, []byte("{}")...), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := readReserveJSON(path, &activation); err == nil {
		t.Fatal("trailing activation data accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, 1024*1024+1), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := readReserveJSON(path, &activation); err == nil {
		t.Fatal("unbounded activation data accepted")
	}
}
