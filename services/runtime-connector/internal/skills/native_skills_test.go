package skills

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/trust"
)

func nativeSkillsAssignment() protocol.Assignment {
	assignment := protocol.Assignment{
		RuntimeAttemptID: "owned-native-skills", Generation: 1,
		WorkspaceFolder: "/var/lib/factory/source/project", ConnectorStateDir: trust.BootstrapStateDirectory,
		Channels: []protocol.Channel{{Name: "agent", Kind: "agent"}},
	}
	assignment.SetNativeActorUID("6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1")
	return assignment
}

func TestNativeSkillsAdmissionRejectsUnassignedAndNonNativeControl(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*protocol.Assignment)
		data   string
		want   string
	}{
		{"invalid-json", nil, "{", "invalid admitted"},
		{"oversize", nil, `"` + strings.Repeat("a", 7100000) + `"`, "invalid admitted"},
		{"no-agent", func(a *protocol.Assignment) { a.Channels = []protocol.Channel{{Kind: "ide"}} }, "{}", "assigned Build"},
		{"serialized-only", func(a *protocol.Assignment) { a.SetNativeActorUID("") }, "{}", "native control identity"},
		{"invalid-actor", func(a *protocol.Assignment) { a.SetNativeActorUID("owned") }, "{}", "native control identity"},
		{"missing-attempt", func(a *protocol.Assignment) { a.RuntimeAttemptID = "" }, "{}", "native control identity"},
		{"missing-generation", func(a *protocol.Assignment) { a.Generation = 0 }, "{}", "native control identity"},
		{"project-state", func(a *protocol.Assignment) { a.ConnectorStateDir = "/workspace/state" }, "{}", "native control identity"},
		{"project-checkout", func(a *protocol.Assignment) { a.WorkspaceFolder = "/workspace/project" }, "{}", "native control identity"},
		{"not-native-pid1", nil, "{}", "control"},
	} {
		t.Run(test.name, func(t *testing.T) {
			assignment := nativeSkillsAssignment()
			if test.change != nil {
				test.change(&assignment)
			}
			if err := InstallAdmittedSkills(t.Context(), assignment, test.data); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("admission returned %v, want %q", err, test.want)
			}
		})
	}
}

func TestNativeSkillsCancelledAdmission(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := InstallAdmittedSkills(ctx, nativeSkillsAssignment(), "{}"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled admission: %v", err)
	}
}

func TestNativeSkillsCommandUsesOnlyImmutableControlTools(t *testing.T) {
	t.Setenv("BUN_OPTIONS", "--preload /workspace/project/untrusted.js")
	t.Setenv("LD_PRELOAD", "/workspace/project/untrusted.so")
	t.Setenv("FACTORY_OPENCODE_TOKEN", "must-not-inherit")
	command := nativeSkillsCommand(t.Context(), `{"files":[]}`)
	if command.Path != "/opt/factory/opencode/musl/bun" ||
		!reflect.DeepEqual(command.Args, []string{nativeSkillsBun, "/opt/factory/opencode/server/install-skills.mjs"}) ||
		command.Dir != "/" || !reflect.DeepEqual(command.Env, []string{"PATH=/usr/bin:/bin"}) ||
		command.Cancel == nil || command.WaitDelay != 2*time.Second {
		t.Fatalf("installer lost its fixed tools, environment or cancellation: %+v", command)
	}
	input, err := io.ReadAll(command.Stdin)
	if err != nil || string(input) != `{"files":[]}` {
		t.Fatalf("installer input: %q, %v", input, err)
	}
}

func TestNativeSkillsCommandCancellationReapsInstaller(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	command := nativeSkillsCommand(ctx, "")
	command.Path, command.Args = "/bin/sh", []string{"sh", "-c", "exec sleep 60"}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	cancel()
	if err := command.Wait(); err == nil || command.ProcessState == nil {
		t.Fatalf("cancelled installer was not reaped: %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("installer cancellation exceeded its pipe/reaping bound")
	}
}

func TestNativeSkillsOutputIsBounded(t *testing.T) {
	var output nativeSkillsOutput
	for range 10 {
		if count, err := output.Write([]byte(strings.Repeat("x", 3000))); count != 3000 || err != nil {
			t.Fatalf("output was not drained: %d, %v", count, err)
		}
	}
	if output.Len() != 2000 {
		t.Fatalf("retained %d output bytes", output.Len())
	}
}
