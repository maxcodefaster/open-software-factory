package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func injectionTimingFixture(t *testing.T) (string, func() []string) {
	t.Helper()
	directory := t.TempDir()
	logPath := filepath.Join(directory, "timings")
	output, err := os.OpenFile(logPath, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	stderr := os.Stderr
	os.Stderr = output
	t.Cleanup(func() {
		os.Stderr = stderr
		output.Close()
	})
	script := `#!/bin/sh
case "$*" in
  cp*:/tmp/factory-runtime-connector-*) step=connector-copy ;;
  cp*:/tmp/factory-runtime-assignment-*) step=assignment-copy ;;
  *ldd*) step=libc-probe ;;
  *mkdir*/language-tools/runtime) step=languages-setup ;;
  cp*/language-tools/node_modules*) step=languages-tree ;;
  cp*/language-tools/*/.*) step=languages-runtime ;;
  *mkdir*/opencode) step=opencode-setup ;;
  cp*/opencode/server*) step=opencode-server ;;
  cp*:/opt/factory/opencode/bun) step=opencode-runtime ;;
  *chmod*/opencode/bun) step=opencode-permissions ;;
  *mkdir*/opt/factory) step=runner-setup ;;
  cp*:/opt/factory/forgejo-runner) step=runner-copy ;;
  *chmod*/forgejo-runner) step=runner-permissions ;;
  *factory-connector-setup*) step=child-permissions ;;
  exec\ --interactive*) step=child-start ;;
  *) exit 99 ;;
esac
printf 'command:%s\n' "$step" >> "$FACTORY_INJECTION_LOG"
if [ "$FACTORY_INJECTION_FAIL" = "$step" ]; then
  printf 'private-tool-diagnostic\n' >&2
  exit 23
fi
if [ "$FACTORY_INJECTION_CANCEL" = "$step" ]; then
  : > "$FACTORY_INJECTION_REACHED"
  exec /bin/sleep 30
fi
if [ "$step" = libc-probe ]; then printf 'musl\n'; fi
if [ "$step" = child-start ]; then /bin/cat >/dev/null; fi
if [ "$FACTORY_INJECTION_REMOVE_AT" = "$step" ]; then /bin/rm "$0"; fi
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("FACTORY_INJECTION_LOG", logPath)
	t.Setenv("FACTORY_INJECTION_FAIL", "")
	t.Setenv("FACTORY_INJECTION_CANCEL", "")
	t.Setenv("FACTORY_INJECTION_REMOVE_AT", "")
	t.Setenv("FACTORY_INJECTION_REACHED", filepath.Join(directory, "reached"))
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "")
	return directory, func() []string {
		t.Helper()
		content, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		var timeline []string
		for _, line := range strings.Split(strings.TrimSpace(string(content)), "\n") {
			if strings.HasPrefix(line, "Connector child for attempt owned-timing-attempt generation ") {
				timeline = append(timeline, "child-exited")
				continue
			}
			if strings.HasPrefix(line, "command:") {
				timeline = append(timeline, line)
				continue
			}
			if !strings.HasPrefix(line, "factory-startup ") {
				continue
			}
			for _, private := range []string{"private-child-token", "private-runtime-secret", "private-tool-diagnostic", directory} {
				if strings.Contains(line, private) {
					t.Fatal("startup measurement exposed private input or command diagnostics")
				}
			}
			var fields map[string]json.RawMessage
			var measurement startupMeasurement
			data := []byte(strings.TrimPrefix(line, "factory-startup "))
			if json.Unmarshal(data, &fields) != nil || len(fields) != 3 ||
				json.Unmarshal(data, &measurement) != nil || measurement.DurationMS < 0 {
				t.Fatal("startup measurement changed its bounded phase/clock schema")
			}
			if _, err := time.Parse(time.RFC3339Nano, measurement.StartedAt); err != nil {
				t.Fatal("startup phase has no valid start time")
			}
			timeline = append(timeline, "phase:"+measurement.Phase)
		}
		return timeline
	}
}

func injectionTimingAssignment() Assignment {
	assignment := validAssignment()
	assignment.RuntimeAttemptID = "owned-timing-attempt"
	assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}, {Name: "agent", Kind: "agent"}, {Name: "verification", Kind: "verification"}}
	assignment.RuntimeEnvironment = map[string]string{"OWNED_SECRET": "private-runtime-secret"}
	return assignment
}

var injectionTimingCommands = []struct {
	command string
	phases  []string
	error   string
}{
	{"connector-copy", []string{"child-executable-copy", "child-connector-injection"}, "copy Connector tool:"},
	{"assignment-copy", []string{"child-assignment-copy"}, "copy Connector child assignment:"},
	{"libc-probe", []string{"language-tools-probe"}, "Language tools require"},
	{"languages-setup", []string{"language-tools-setup"}, "create language tools destination:"},
	{"languages-tree", []string{"language-tools-tree-copy"}, "inject language tools:"},
	{"languages-runtime", []string{"language-tools-runtime-copy"}, "inject language tools:"},
	{"libc-probe", []string{"opencode-probe"}, "OpenCode requires"},
	{"opencode-setup", []string{"opencode-setup"}, "create OpenCode destination:"},
	{"opencode-server", []string{"opencode-server-copy"}, "inject native OpenCode server:"},
	{"opencode-runtime", []string{"child-executable-copy", "opencode-runtime-injection"}, "inject OpenCode:"},
	{"opencode-permissions", []string{"opencode-permissions"}, "prepare OpenCode:"},
	{"runner-setup", []string{"verification-runner-setup"}, "create Forgejo Runner destination:"},
	{"runner-copy", []string{"child-executable-copy", "verification-runner-injection"}, "inject Forgejo Runner:"},
	{"runner-permissions", []string{"verification-runner-permissions"}, "prepare Forgejo Runner:"},
	{"child-permissions", []string{"child-permissions"}, "prepare Connector child artifact permissions:"},
}

func TestInjectionTimingSuccessPreservesCommandOrderAndTotal(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	finish := startupPhase("tool-injection")
	err := injectChild(context.Background(), injectionTimingAssignment(), devcontainerResult{
		ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
	}, "private-child-token")
	finish()
	if err != nil {
		t.Fatal("stubbed injection failed")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		entries := timeline()
		if slices.Contains(entries, "child-exited") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stub child did not consume its stdin")
		}
		time.Sleep(time.Millisecond)
	}
	want := []string{"phase:child-staging"}
	for _, step := range injectionTimingCommands {
		want = append(want, "command:"+step.command)
		for _, phase := range step.phases {
			want = append(want, "phase:"+phase)
		}
	}
	want = append(want, "phase:child-transport", "phase:child-start", "phase:tool-injection")
	var got []string
	for _, entry := range timeline() {
		// Start measures process launch, not completion of the child process.
		if entry != "command:child-start" && entry != "child-exited" {
			got = append(got, entry)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("injection phase/command order changed:\ngot %v\nwant %v", got, want)
	}
}

func TestInjectionTimingFailureEndsAtTheFailedCommand(t *testing.T) {
	for index, failed := range injectionTimingCommands {
		// Both libc probes have the same fake command. The first is enough
		// here; the OpenCode-only probe is exercised separately below.
		if index == 6 {
			continue
		}
		t.Run(failed.command, func(t *testing.T) {
			_, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_FAIL", failed.command)
			err := injectChild(context.Background(), injectionTimingAssignment(), devcontainerResult{
				ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
			}, "private-child-token")
			if err == nil || !strings.Contains(err.Error(), failed.error) {
				t.Fatal("injection did not retain the failing command's error")
			}
			want := []string{"phase:child-staging"}
			for _, step := range injectionTimingCommands[:index+1] {
				want = append(want, "command:"+step.command)
				for _, phase := range step.phases {
					want = append(want, "phase:"+phase)
				}
			}
			if got := timeline(); !reflect.DeepEqual(got, want) {
				t.Fatalf("failed operation lost timing or dispatched a later step:\ngot %v\nwant %v", got, want)
			}
		})
	}
}

func TestInjectionTimingCancellationFinishesPendingPayloadCopy(t *testing.T) {
	for _, step := range []struct{ command, phase string }{
		{"languages-tree", "language-tools-tree-copy"},
		{"opencode-server", "opencode-server-copy"},
	} {
		t.Run(step.command, func(t *testing.T) {
			directory, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_CANCEL", step.command)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- injectChild(ctx, injectionTimingAssignment(), devcontainerResult{
					ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
				}, "private-child-token")
			}()
			deadline := time.Now().Add(2 * time.Second)
			for {
				if _, err := os.Stat(os.Getenv("FACTORY_INJECTION_REACHED")); err == nil {
					break
				}
				if time.Now().After(deadline) {
					cancel()
					<-done
					t.Fatal("stub did not enter the selected payload copy")
				}
				time.Sleep(time.Millisecond)
			}
			observedAt := time.Now()
			cancel()
			select {
			case err := <-done:
				if err == nil || !errors.Is(ctx.Err(), context.Canceled) {
					t.Fatal("payload-copy cancellation was lost")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("canceled payload copy was not joined")
			}
			entries := timeline()
			if len(entries) == 0 || entries[len(entries)-1] != "phase:"+step.phase ||
				slices.Contains(entries, "phase:child-start") || slices.Contains(entries, "command:child-start") {
				t.Fatal("canceled copy lost its completion timing or started the child")
			}
			content, err := os.ReadFile(filepath.Join(directory, "timings"))
			if err != nil {
				t.Fatal(err)
			}
			measured := false
			for _, line := range strings.Split(string(content), "\n") {
				var measurement startupMeasurement
				if !strings.HasPrefix(line, "factory-startup ") ||
					json.Unmarshal([]byte(strings.TrimPrefix(line, "factory-startup ")), &measurement) != nil ||
					measurement.Phase != step.phase {
					continue
				}
				started, err := time.Parse(time.RFC3339Nano, measurement.StartedAt)
				if err != nil || started.After(observedAt) ||
					started.Add(time.Duration(measurement.DurationMS+1)*time.Millisecond).Before(observedAt) {
					t.Fatal("copy timing did not include its pending command before cancellation")
				}
				measured = true
			}
			if !measured {
				t.Fatal("pending copy did not emit its phase timing")
			}
		})
	}
}

func TestInjectionTimingOpenCodeProbeFailure(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	t.Setenv("FACTORY_INJECTION_FAIL", "libc-probe")
	assignment := injectionTimingAssignment()
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent"}}
	err := injectApprovedTools(context.Background(), assignment, "owned-child")
	if err == nil || !strings.Contains(err.Error(), "OpenCode requires") {
		t.Fatal("OpenCode's failed libc probe changed its error")
	}
	if got, want := timeline(), []string{"command:libc-probe", "phase:opencode-probe"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("failed OpenCode probe lost timing or copied a tool: got %v", got)
	}
}

func TestInjectionTimingStagingAndNativeTransportFailures(t *testing.T) {
	for _, step := range []string{"assignment-staging", "native-trust"} {
		t.Run(step, func(t *testing.T) {
			directory, timeline := injectionTimingFixture(t)
			want := []string{"phase:child-staging"}
			if step == "assignment-staging" {
				t.Setenv("TMPDIR", filepath.Join(directory, "missing"))
			} else {
				t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "owned-native")
				t.Setenv("SSL_CERT_FILE", "")
				want = append(want,
					"phase:child-executable-staging", "command:connector-copy",
					"phase:child-executable-copy", "phase:child-connector-injection",
					"command:assignment-copy", "phase:child-assignment-copy",
					"command:child-permissions", "phase:child-permissions", "phase:child-transport")
			}
			assignment := injectionTimingAssignment()
			assignment.Channels = []Channel{{Name: "app", Kind: "app"}}
			err := injectChild(context.Background(), assignment, devcontainerResult{
				ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
			}, "private-child-token")
			if err == nil || (step == "assignment-staging" && !os.IsNotExist(err)) ||
				(step == "native-trust" && err.Error() != "native child trust is unavailable") {
				t.Fatal("staging or native transport changed its failure")
			}
			if got := timeline(); !reflect.DeepEqual(got, want) {
				t.Fatalf("failed setup lost timing or started a child:\ngot %v\nwant %v", got, want)
			}
		})
	}
}

func TestInjectionTimingChildStartFailure(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	// With the stub-only PATH, removing this executable cannot fall through to
	// a real Docker. Start fails before dispatching any child process.
	t.Setenv("FACTORY_INJECTION_REMOVE_AT", "child-permissions")
	assignment := injectionTimingAssignment()
	assignment.Channels = []Channel{{Name: "app", Kind: "app"}}
	err := injectChild(context.Background(), assignment, devcontainerResult{
		ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
	}, "private-child-token")
	if err == nil || !strings.Contains(err.Error(), "start Connector child:") {
		t.Fatal("child Start failure changed its error")
	}
	want := []string{
		"phase:child-staging", "command:connector-copy", "phase:child-executable-copy",
		"phase:child-connector-injection", "command:assignment-copy", "phase:child-assignment-copy",
		"command:child-permissions", "phase:child-permissions", "phase:child-transport", "phase:child-start",
	}
	if got := timeline(); !reflect.DeepEqual(got, want) {
		t.Fatalf("failed child Start lost timing:\ngot %v\nwant %v", got, want)
	}
}

func TestInjectionTimingExecutableStagingAndCopy(t *testing.T) {
	for _, scenario := range []string{"success", "missing-artifact", "copy-failed", "canceled"} {
		t.Run(scenario, func(t *testing.T) {
			directory, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "owned-native")
			source := filepath.Join(directory, "shipped")
			if scenario != "missing-artifact" {
				if err := os.WriteFile(source, []byte("owned shipped tool"), 0555); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "canceled" {
				cancel()
			}
			if scenario == "copy-failed" {
				t.Setenv("FACTORY_INJECTION_FAIL", "connector-copy")
			}
			err := copyChildExecutable(ctx, "owned-child", source, "/tmp/factory-runtime-connector-7")
			if (scenario == "success" && err != nil) || (scenario != "success" && err == nil) ||
				(scenario == "missing-artifact" && !os.IsNotExist(err)) ||
				(scenario == "canceled" && !errors.Is(err, context.Canceled)) {
				t.Fatal("artifact staging/copy changed its result")
			}
			want := []string{"phase:child-executable-staging"}
			if scenario != "missing-artifact" {
				if scenario != "canceled" {
					want = append(want, "command:connector-copy")
				}
				want = append(want, "phase:child-executable-copy")
			}
			if got := timeline(); !reflect.DeepEqual(got, want) {
				t.Fatalf("artifact staging/copy lost bounded timing: got %v want %v", got, want)
			}
		})
	}
}
