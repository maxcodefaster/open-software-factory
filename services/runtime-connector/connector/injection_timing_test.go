package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLanguageArchiveProcess(t *testing.T) {
	if os.Getenv("FACTORY_LANGUAGE_ARCHIVE_PROCESS") != "1" {
		return
	}
	archive, err := os.ReadFile(os.Getenv("FACTORY_LANGUAGE_ARCHIVE"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stdout.Write(archive[:64<<10]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("FACTORY_LANGUAGE_PRODUCER_PID"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(os.Getenv("FACTORY_LANGUAGE_ARCHIVE_RELEASE")); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stdout.Write(archive[64<<10:]); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}

func injectionTimingFixture(t *testing.T) (string, func() []string) {
	t.Helper()
	directory := t.TempDir()
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	fixturePrebuildTools(t, filepath.Join(directory, "opencode"))
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
if [ "$FACTORY_INJECTION_RUN_CHILD" = 1 ]; then
  case "$1" in
    info|ps) exit 0 ;;
    inspect) printf '%s\n' "$FACTORY_INJECTION_CONTAINER"; exit 0 ;;
    rm) : > "$FACTORY_INJECTION_CHILD_STOP"; exit 0 ;;
  esac
fi
case "$*" in
  cp*:/tmp/factory-runtime-connector-*) step=connector-copy ;;
  cp*:/tmp/factory-runtime-assignment-*) step=assignment-copy ;;
  *ldd*) step=libc-probe ;;
  *opencode-verify*) step=opencode-verify ;;
  *opencode-reset*) step=opencode-reset ;;
  *factory-language-tools-setup*) step=languages-setup ;;
  exec*tar*-C*/language-tools/node_modules) step=languages-tree ;;
  exec*tar*-C*/language-tools/.runtime-*) step=languages-runtime ;;
  *mv*/language-tools/.runtime-*) step=languages-publish ;;
  *mkdir*/opencode/server) step=opencode-setup ;;
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
printf '%s\n' "$*" >> "$FACTORY_INJECTION_COMMAND_LOG"
if [ "$step" = opencode-verify ]; then
  /bin/cat >/dev/null
  test -f "$FACTORY_INJECTION_OPENCODE_COPIED"
  exit "$?"
fi
if [ "$step" = opencode-reset ]; then /bin/rm -f "$FACTORY_INJECTION_OPENCODE_COPIED"; fi
if [ "$FACTORY_INJECTION_FAIL" = "$step" ]; then
  printf 'private-tool-diagnostic\n' >&2
  exit 23
fi
case "$step" in languages-tree|languages-runtime)
  printf '%s\n' "$$" > "$FACTORY_INJECTION_REACHED.$step.consumer"
  # The consumer exits on producer EOF, including Stop, like the inner tar.
  /bin/cat >/dev/null
  exit 0
esac
case " $FACTORY_INJECTION_CANCEL " in *" $step "*)
  printf '%s\n' "$$" > "$FACTORY_INJECTION_REACHED"
  printf '%s\n' "$$" > "$FACTORY_INJECTION_REACHED.$step"
  exec /bin/sleep 30
esac
if [ "$step" = libc-probe ]; then
  printf '%s\n' "$FACTORY_INJECTION_LIBC"
  exit "$FACTORY_INJECTION_LIBC_STATUS"
fi
if [ "$step" = opencode-permissions ]; then : > "$FACTORY_INJECTION_OPENCODE_COPIED"; fi
if [ "$FACTORY_INJECTION_RUN_CHILD" = 1 ]; then
  if [ "$step" = assignment-copy ]; then /bin/cp "$2" "$FACTORY_INJECTION_ASSIGNMENT"; fi
  if [ "$step" = child-start ]; then exec "$FACTORY_INJECTION_EXECUTABLE" -test.run='^TestParentInjectedChildProcess$'; fi
fi
if [ "$step" = child-start ]; then /bin/cat >/dev/null; fi
if [ "$FACTORY_INJECTION_REMOVE_AT" = "$step" ]; then /bin/rm "$0"; fi
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	producer := `#!/bin/sh
printf 'tar %s\n' "$*" >> "$FACTORY_INJECTION_COMMAND_LOG"
case "$2" in
  */node_modules) step=languages-tree ;;
  */musl|*/glibc) step=languages-runtime ;;
  *) exit 99 ;;
esac
case " $FACTORY_INJECTION_CANCEL " in *" $step "*)
  printf '%s\n' "$$" > "$FACTORY_INJECTION_REACHED"
  printf '%s\n' "$$" > "$FACTORY_INJECTION_REACHED.$step"
  exec /bin/sleep 30
esac
printf 'owned archive fixture'
`
	if err := os.WriteFile(filepath.Join(directory, "tar"), []byte(producer), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("FACTORY_INJECTION_LOG", logPath)
	t.Setenv("FACTORY_INJECTION_OPENCODE_COPIED", filepath.Join(directory, "opencode-copied"))
	t.Setenv("FACTORY_INJECTION_COMMAND_LOG", filepath.Join(directory, "commands"))
	t.Setenv("FACTORY_INJECTION_LIBC", "musl")
	t.Setenv("FACTORY_INJECTION_LIBC_STATUS", "0")
	t.Setenv("FACTORY_INJECTION_FAIL", "")
	t.Setenv("FACTORY_INJECTION_CANCEL", "")
	t.Setenv("FACTORY_INJECTION_REMOVE_AT", "")
	t.Setenv("FACTORY_INJECTION_REACHED", filepath.Join(directory, "reached"))
	t.Setenv("FACTORY_INJECTION_RUN_CHILD", "")
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

func injectionTimingContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, openCodeArtifactsRootKey{},
		filepath.Join(filepath.Dir(os.Getenv("FACTORY_INJECTION_LOG")), "opencode"))
}

func requiredInjectionTimeline(entries []string) []string {
	var required []string
	for _, entry := range entries {
		if strings.HasPrefix(entry, "command:languages-") ||
			(strings.HasPrefix(entry, "phase:language-tools-") && entry != "phase:language-tools-probe") ||
			strings.HasPrefix(entry, "command:opencode-verify") ||
			strings.HasPrefix(entry, "command:opencode-reset") ||
			strings.HasPrefix(entry, "phase:opencode-artifact-") {
			continue
		}
		required = append(required, entry)
	}
	return required
}

var injectionTimingCommands = []struct {
	command string
	phases  []string
	error   string
}{
	{"connector-copy", []string{"child-executable-copy", "child-connector-injection"}, "copy Connector tool:"},
	{"assignment-copy", []string{"child-assignment-copy"}, "copy Connector child assignment:"},
	{"libc-probe", []string{"language-tools-probe"}, "Language tools require"},
	{"opencode-setup", []string{"opencode-setup"}, "create OpenCode destination:"},
	{"opencode-server", []string{"opencode-server-copy"}, "inject native OpenCode server:"},
	{"opencode-runtime", []string{"child-executable-copy", "opencode-runtime-injection"}, "inject OpenCode:"},
	{"opencode-permissions", []string{"opencode-permissions"}, "prepare OpenCode:"},
	{"runner-setup", []string{"verification-runner-setup"}, "create Forgejo Runner destination:"},
	{"runner-copy", []string{"child-executable-copy", "verification-runner-injection"}, "inject Forgejo Runner:"},
	{"runner-permissions", []string{"verification-runner-permissions"}, "prepare Forgejo Runner:"},
	{"child-permissions", []string{"child-permissions"}, "prepare Connector child artifact permissions:"},
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
