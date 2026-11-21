package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type standaloneCleanupAbsenceFixture struct {
	state      parentState
	directory  string
	log        string
	inspection string
}

func newStandaloneCleanupAbsenceFixture(t *testing.T, inspection, inventory string, removed bool) standaloneCleanupAbsenceFixture {
	t.Helper()
	directory := t.TempDir()
	id := strings.Repeat("ab", 32)
	attempt := "11111111-1111-4111-8111-111111111111"
	origin := containerOrigin{AttemptID: attempt, Generation: 7}
	fixture := standaloneCleanupAbsenceFixture{
		state: parentState{
			RuntimeAttemptID: attempt, Generation: 7, ContainerID: id,
			ComposeProjectName: "logical_workspace", ContainerOrigin: &origin,
			PreserveWorkspace: true,
		},
		directory: directory, log: filepath.Join(directory, "commands"),
		inspection: filepath.Join(directory, "inspection.json"),
	}
	var primary inspectedContainer
	primary.ID = id
	primary.Config.Labels = map[string]string{attemptLabel: attempt, generationLabel: "7"}
	data, err := json.Marshal([]inspectedContainer{primary})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.inspection, data, 0600); err != nil {
		t.Fatal(err)
	}
	if removed {
		if err := os.WriteFile(filepath.Join(directory, "removed"), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	// No daemon is used. Inventory answers for the exact immutable ID, regardless
	// of labels: filtering by owner labels could hide an existing changed owner.
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$FACTORY_STANDALONE_ABSENCE_ROOT/commands"
case "$1" in
  inspect)
    if [ "$FACTORY_STANDALONE_ABSENCE_INSPECTION" = unavailable ]; then
      printf '%s\n' 'Cannot connect to the Docker daemon' >&2
      exit 2
    fi
    if [ "$2" != "$FACTORY_STANDALONE_ABSENCE_ID" ] || [ -f "$FACTORY_STANDALONE_ABSENCE_ROOT/removed" ]; then
      if [ "$FACTORY_STANDALONE_ABSENCE_INSPECTION" = lowercase ]; then
        printf 'error: no such object: %s\n' "$2" >&2
      else
        printf 'Error: No such object: %s\n' "$2" >&2
      fi
      exit 1
    fi
    cat "$FACTORY_STANDALONE_ABSENCE_ROOT/inspection.json"
    ;;
  ps)
    shift
    all=false; quiet=false; full=false; identity=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -a|--all) all=true ;;
        -q|--quiet) quiet=true ;;
        -aq|-qa) all=true; quiet=true ;;
        --no-trunc) full=true ;;
        --filter)
          shift
          [ "$#" -gt 0 ] && [ "$1" = "id=$FACTORY_STANDALONE_ABSENCE_ID" ] || exit 90
          identity=true ;;
        --filter=*)
          [ "$1" = "--filter=id=$FACTORY_STANDALONE_ABSENCE_ID" ] || exit 90
          identity=true ;;
        *) exit 90 ;;
      esac
      shift
    done
    [ "$all" = true ] && [ "$quiet" = true ] && [ "$full" = true ] && [ "$identity" = true ] || exit 91
    if [ "$FACTORY_STANDALONE_ABSENCE_INVENTORY" = unavailable ]; then
      printf '%s\n' 'Docker inventory read is unavailable' >&2
      exit 3
    fi
    if [ "$FACTORY_STANDALONE_ABSENCE_INVENTORY" = present ] || [ ! -f "$FACTORY_STANDALONE_ABSENCE_ROOT/removed" ]; then
      printf '%s\n' "$FACTORY_STANDALONE_ABSENCE_ID"
    fi
    ;;
  rm)
    [ "$#" = 3 ] && [ "$2" = -f ] && [ "$3" = "$FACTORY_STANDALONE_ABSENCE_ID" ] || exit 92
    touch "$FACTORY_STANDALONE_ABSENCE_ROOT/removed"
    ;;
  *) exit 93 ;;
esac
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_STANDALONE_ABSENCE_ROOT", directory)
	t.Setenv("FACTORY_STANDALONE_ABSENCE_ID", id)
	t.Setenv("FACTORY_STANDALONE_ABSENCE_INSPECTION", inspection)
	t.Setenv("FACTORY_STANDALONE_ABSENCE_INVENTORY", inventory)
	return fixture
}

func TestStandaloneCleanupAcceptsCurrentNativeDockerMissingObject(t *testing.T) {
	f := newStandaloneCleanupAbsenceFixture(t, "lowercase", "absent", true)
	if err := cleanupProject(t.Context(), f.state); err != nil {
		t.Fatalf("current Docker's confirmed missing object failed: %v", err)
	}
	commands, err := os.ReadFile(f.log)
	if err != nil || !strings.Contains(string(commands), "--filter id="+f.state.ContainerID) {
		t.Fatal("missing-object response skipped independent identity inventory")
	}
}

func TestStandaloneCleanupAlreadyRemovedOwnedPrimaryIsIdempotent(t *testing.T) {
	fixture := newStandaloneCleanupAbsenceFixture(t, "available", "available", false)
	if err := cleanupProject(t.Context(), fixture.state); err != nil {
		t.Fatalf("original full-ID/label-bound standalone cleanup failed: %v", err)
	}
	if err := cleanupProject(t.Context(), fixture.state); err != nil {
		t.Errorf("already-removed owned standalone primary was not confirmed absent: %v", err)
	}
	commands, err := os.ReadFile(fixture.log)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(commands), "rm -f "+fixture.state.ContainerID+"\n") != 1 {
		t.Errorf("idempotent cleanup repeated removal or selected another identity: %s", commands)
	}
	if !strings.Contains(string(commands), "id="+fixture.state.ContainerID) ||
		!strings.Contains(string(commands), "--no-trunc") {
		t.Errorf("absence was not positively observed for the full immutable ID: %s", commands)
	}
	if strings.Contains(string(commands), "network ") || strings.Contains(string(commands), "volume ") ||
		strings.Contains(string(commands), "logical_workspace") {
		t.Errorf("standalone cleanup adopted the logical Compose name or touched retained volumes: %s", commands)
	}
}

func TestStandaloneCleanupUnavailableObservationIsNotAbsence(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		inspection string
		inventory  string
		removed    bool
	}{
		{"inspection-unavailable-primary-present", "unavailable", "available", false},
		{"inspection-unavailable-inventory-empty", "unavailable", "available", true},
		{"inventory-unavailable-primary-removed", "available", "unavailable", true},
		{"missing-object-inventory-still-present", "available", "present", true},
		{"both-observations-unavailable", "unavailable", "unavailable", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newStandaloneCleanupAbsenceFixture(t, scenario.inspection, scenario.inventory, scenario.removed)
			if err := cleanupProject(t.Context(), fixture.state); err == nil {
				t.Error("unavailable standalone observation was reported as confirmed cleanup")
			}
			commands, err := os.ReadFile(fixture.log)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(commands), "rm ") || strings.Contains(string(commands), "network ") ||
				strings.Contains(string(commands), "volume ") {
				t.Errorf("unavailable observation permitted resource removal: %s", commands)
			}
		})
	}
}

func TestStandaloneCleanupPositiveAbsenceRequiresBoundFullIdentity(t *testing.T) {
	for _, scenario := range []string{"short-id", "missing-attempt", "zero-generation"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newStandaloneCleanupAbsenceFixture(t, "available", "available", true)
			switch scenario {
			case "short-id":
				fixture.state.ContainerID = fixture.state.ContainerID[:12]
			case "missing-attempt":
				fixture.state.ContainerOrigin.AttemptID = ""
			case "zero-generation":
				fixture.state.ContainerOrigin.Generation = 0
			}
			if err := cleanupProject(t.Context(), fixture.state); err == nil {
				t.Fatal("unbound standalone identity was reported as positively absent")
			}
		})
	}
}

func TestStandaloneCleanupRetainsActualNativeLabelGuard(t *testing.T) {
	for _, changed := range []string{attemptLabel, generationLabel} {
		t.Run(changed, func(t *testing.T) {
			fixture := newStandaloneCleanupAbsenceFixture(t, "available", "available", false)
			raw, err := os.ReadFile(fixture.inspection)
			if err != nil {
				t.Fatal(err)
			}
			var primary []inspectedContainer
			if err := json.Unmarshal(raw, &primary); err != nil {
				t.Fatal(err)
			}
			primary[0].Config.Labels[changed] = "changed"
			raw, err = json.Marshal(primary)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(fixture.inspection, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := cleanupProject(t.Context(), fixture.state); err == nil {
				t.Fatal("standalone cleanup bypassed the original native label guard")
			}
			commands, err := os.ReadFile(fixture.log)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(commands), "rm ") {
				t.Errorf("cleanup removed a primary with changed native labels: %s", commands)
			}
		})
	}
}
