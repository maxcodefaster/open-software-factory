package connector

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
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

// Explicit component lane only. A held real extraction must not hold Docker's
// archive lock, and cancellation must join both local CLIs and the inner tar.
func TestLanguageToolCopyDockerComponent(t *testing.T) {
	image := os.Getenv("FACTORY_LANGUAGE_COPY_COMPONENT_IMAGE")
	if image == "" {
		t.Skip("requires an explicitly owned pinned Docker component image")
	}
	if !browserImagePattern.MatchString(image) {
		t.Fatal("component image must be pinned")
	}
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	source, target := filepath.Join(directory, "source"), filepath.Join(directory, "target")
	for _, path := range []string{source, target} {
		if err := os.Mkdir(path, 0755); err != nil {
			t.Fatal(err)
		}
	}
	const first = "owned first file proves extraction began\n"
	if err := os.WriteFile(filepath.Join(source, "first"), []byte(first), 0555); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	for _, file := range []struct {
		name string
		body []byte
	}{{"first", []byte(first)}, {"remaining", bytes.Repeat([]byte{42}, 2<<20)}} {
		if err := writer.WriteHeader(&tar.Header{Name: file.name, Mode: 0555, Size: int64(len(file.body)), Uid: 65534, Gid: 65534}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(file.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	archivePath, releasePath := filepath.Join(directory, "archive"), filepath.Join(directory, "release")
	if err := os.WriteFile(archivePath, archive.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	binaries := filepath.Join(directory, "bin")
	if err := os.Mkdir(binaries, 0700); err != nil {
		t.Fatal(err)
	}
	for name, script := range map[string]string{
		"tar":    fmt.Sprintf("#!/bin/sh\nexec %q -test.run='^TestLanguageArchiveProcess$'\n", os.Args[0]),
		"docker": fmt.Sprintf("#!/bin/sh\nprintf '%%s' $$ > \"$FACTORY_LANGUAGE_CONSUMER_PID\"\nexec %q \"$@\"\n", docker),
	} {
		if err := os.WriteFile(filepath.Join(binaries, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", binaries+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_LANGUAGE_ARCHIVE_PROCESS", "1")
	t.Setenv("FACTORY_LANGUAGE_ARCHIVE", archivePath)
	t.Setenv("FACTORY_LANGUAGE_ARCHIVE_RELEASE", releasePath)
	t.Setenv("FACTORY_LANGUAGE_PRODUCER_PID", filepath.Join(directory, "producer-pid"))
	t.Setenv("FACTORY_LANGUAGE_CONSUMER_PID", filepath.Join(directory, "consumer-pid"))
	owner := strings.ToLower(rand.Text())
	label := "factory.language-copy-owner"
	name := "factory-language-copy-" + owner
	command := func(ctx context.Context, args ...string) (string, error) {
		output, err := ownedCommand(ctx, docker, args...).CombinedOutput()
		return strings.TrimSpace(string(output)), err
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), runtimeCleanupTimeout)
		defer cancel()
		identity, err := command(ctx, "inspect", "--format", `{{.Id}} {{.Name}} {{index .Config.Labels "`+label+`"}}`, name)
		if err != nil {
			t.Errorf("could not confirm component cleanup identity: %v: %s", err, identity)
			return
		}
		fields := strings.Fields(identity)
		if len(fields) != 3 || len(fields[0]) != 64 || fields[1] != "/"+name || fields[2] != owner {
			t.Error("component cleanup refused an unconfirmed owner")
			return
		}
		if output, err := command(ctx, "rm", "--force", fields[0]); err != nil {
			t.Errorf("exact owned component cleanup: %v: %s", err, output)
		}
	})
	// Pull progress belongs to stderr, not the immutable container ID.
	create := ownedCommand(t.Context(), docker, "run", "--detach",
		"--name", name, "--label", label+"="+owner,
		"--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--read-only", "--memory", "256m", "--cpus", "1",
		"--mount", "type=bind,src="+target+",dst=/proof", image, "sleep", "120")
	output, err := create.Output()
	containerID := strings.TrimSpace(string(output))
	if err != nil || len(containerID) != 64 {
		t.Fatalf("create exact owned component container: %v: %s", err, containerID)
	}
	if output, err := command(t.Context(), "exec", containerID, "mkdir", "-p", "/proof/tools"); err != nil {
		t.Fatalf("prepare owned target: %v: %s", err, output)
	}
	until := func(check func() bool, explanation string) {
		t.Helper()
		for deadline := time.Now().Add(3 * time.Second); ; {
			if check() {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal(explanation)
			}
			time.Sleep(time.Millisecond)
		}
	}
	for _, canceled := range []bool{false, true} {
		os.Remove(releasePath)
		os.Remove(filepath.Join(target, "tools", "first"))
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() { done <- streamLanguageToolContents(ctx, containerID, source, "/proof/tools") }()
		joined := false
		cleanup := func() {
			_ = os.WriteFile(releasePath, nil, 0600)
			cancel()
			if !joined {
				<-done
			}
		}
		t.Cleanup(cleanup)
		until(func() bool {
			body, err := os.ReadFile(filepath.Join(target, "tools", "first"))
			return err == nil && string(body) == first
		}, "real extraction never entered its mounted target")
		select {
		case err := <-done:
			joined = true
			t.Fatalf("copy settled before the deliberately held producer was released: %v", err)
		default:
		}
		required := filepath.Join(directory, "required")
		if err := os.WriteFile(required, []byte("required Child startup asset"), 0600); err != nil {
			t.Fatal(err)
		}
		requiredContext, stopRequired := context.WithTimeout(t.Context(), time.Second)
		output, err := command(requiredContext, "cp", required, containerID+":/proof/required")
		stopRequired()
		if err != nil {
			t.Fatalf("held optional copy blocked real required Docker startup copy: %v: %s", err, output)
		}
		if canceled {
			cancel()
		} else if err := os.WriteFile(releasePath, nil, 0600); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			joined = true
			if canceled != (err != nil) {
				t.Fatalf("copy outcome did not retain cancellation: %v", err)
			}
			if canceled && !errors.Is(err, context.Canceled) {
				t.Fatalf("copy hid the cancellation cause: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("owned producer/consumer did not join after stdin closed")
		}
		cancel()
		for _, path := range []string{"FACTORY_LANGUAGE_PRODUCER_PID", "FACTORY_LANGUAGE_CONSUMER_PID"} {
			raw, _ := os.ReadFile(os.Getenv(path))
			pid, _ := strconv.Atoi(string(raw))
			if pid <= 0 || syscall.Kill(pid, 0) != syscall.ESRCH {
				t.Fatal("an owned copy producer or consumer was not reaped")
			}
		}
		if output, err := command(t.Context(), "exec", containerID, "sh", "-c",
			`for p in /proc/[0-9]*/comm; do [ "$(cat "$p")" != tar ] || exit 1; done`); err != nil {
			t.Fatalf("inner extraction survived stdin close before cleanup: %v: %s", err, output)
		}
	}
	// Repeat content injection into an existing ROOTFS directory without nesting.
	if err := os.WriteFile(releasePath, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := streamLanguageToolContents(t.Context(), containerID, source, "/proof/tools"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(target, "tools", "source")); !os.IsNotExist(err) {
		t.Fatal("repeated injection nested the source directory")
	}
	if output, err := command(t.Context(), "exec", "--user", "1000:1000", containerID,
		"cat", "/proof/tools/first"); err != nil || output != strings.TrimSpace(first) {
		t.Fatalf("development user cannot read the copied pinned contents: %v: %s", err, output)
	}
	if output, err := command(t.Context(), "exec", containerID, "stat", "-c", "%u:%g:%a", "/proof/tools/first"); err != nil || output != "0:0:555" {
		t.Fatalf("streaming changed artifact ownership or mode: %v: %s", err, output)
	}
	// Required OpenCode uses archive cp, but copies directory contents on both
	// the initial injection and an existing ROOTFS destination.
	server := filepath.Join(directory, "server")
	if err := os.Mkdir(server, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(server, "index.js"), []byte(first), 0444); err != nil {
		t.Fatal(err)
	}
	if output, err := command(t.Context(), "exec", containerID, "mkdir", "-p", "/proof/server"); err != nil {
		t.Fatalf("prepare server destination: %v: %s", err, output)
	}
	for range 2 {
		if output, err := command(t.Context(), "cp", server+"/.", containerID+":/proof/server"); err != nil {
			t.Fatalf("copy pinned server contents: %v: %s", err, output)
		}
	}
	if body, err := os.ReadFile(filepath.Join(target, "server", "index.js")); err != nil || string(body) != first {
		t.Fatal("server contents were not injected into the canonical destination")
	}
	if _, err := os.Stat(filepath.Join(target, "server", "server")); !os.IsNotExist(err) {
		t.Fatal("repeated server injection nested the server directory")
	}
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

func injectTestApprovedTools(t *testing.T, ctx context.Context, assignment Assignment, containerID string) error {
	t.Helper()
	preparation, err := injectApprovedTools(injectionTimingContext(ctx), assignment, containerID, "/tmp/factory-runtime-connector-1")
	t.Cleanup(preparation.stop)
	<-preparation.done
	if err != nil {
		return err
	}
	return preparation.err
}

func injectTestChild(t *testing.T, ctx context.Context, assignment Assignment, result devcontainerResult, token string) error {
	t.Helper()
	stop, err := injectChild(injectionTimingContext(ctx), assignment, result, token)
	t.Cleanup(stop)
	return err
}

func injectionTimingContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, openCodeArtifactsRootKey{},
		filepath.Join(filepath.Dir(os.Getenv("FACTORY_INJECTION_LOG")), "opencode"))
}

func TestVerifiedPreparedOpenCodeDoesNotRepeatPayloadCopies(t *testing.T) {
	directory, timeline := injectionTimingFixture(t)
	// This is the controlled Docker verification response. Separate artifact
	// tests verify real tree contents; this seam locks down Parent's decision.
	if err := os.WriteFile(os.Getenv("FACTORY_INJECTION_OPENCODE_COPIED"), []byte("prepared\n"), 0600); err != nil {
		t.Fatal(err)
	}
	assignment := injectionTimingAssignment()
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent"}}
	for range 2 {
		if err := injectTestApprovedTools(t, t.Context(), assignment, "owned-child"); err != nil {
			t.Fatal(err)
		}
	}
	commands, err := os.ReadFile(filepath.Join(directory, "commands"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(commands), "opencode-verify") != 2 ||
		strings.Contains(string(commands), "opencode-reset") ||
		strings.Contains(string(commands), "cp ") {
		t.Fatal("exact verified preparation still copied or replaced its OpenCode payload")
	}
	for _, entry := range timeline() {
		if entry == "phase:opencode-server-copy" || entry == "phase:opencode-runtime-injection" {
			t.Fatal("verified reuse recorded a copy that must not occur")
		}
	}
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

func TestApprovedToolsShareOneLibcProbePerInvocation(t *testing.T) {
	for _, libc := range []struct{ name, output, status, tool string }{
		{"musl", "musl", "0", "musl"},
		{"glibc", "ldd (GNU libc) 2.41", "0", "glibc"},
		{"musl-nonzero", "MUSL libc", "1", "musl"},
		{"empty-success", "", "0", "glibc"},
	} {
		t.Run(libc.name, func(t *testing.T) {
			directory, _ := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_LIBC", libc.output)
			t.Setenv("FACTORY_INJECTION_LIBC_STATUS", libc.status)
			assignment := injectionTimingAssignment()
			assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}, {Name: "agent", Kind: "agent"}}
			want := []string{
				"exec owned-child sh -c ldd --version 2>&1",
				`exec --user 0:0 owned-child sh -c rm -rf "$1" "$2" && mkdir -p "$1" "$3" factory-language-tools-setup /opt/factory/language-tools/.runtime-1 /opt/factory/language-tools/runtime /opt/factory/language-tools/node_modules`,
				"tar -C /opt/factory/language-tools/node_modules -cf - .",
				"exec --interactive --user 0:0 owned-child tar --no-same-owner -xf - -C /opt/factory/language-tools/node_modules",
				"tar -C /opt/factory/language-tools/" + libc.tool + " -cf - .",
				"exec --interactive --user 0:0 owned-child tar --no-same-owner -xf - -C /opt/factory/language-tools/.runtime-1",
				"exec --user 0:0 owned-child mv /opt/factory/language-tools/.runtime-1 /opt/factory/language-tools/runtime",
				"exec --user 0:0 owned-child mkdir -p /opt/factory/opencode/server",
				"cp " + filepath.Join(directory, "opencode/server") + "/. owned-child:/opt/factory/opencode/server",
				"cp " + filepath.Join(directory, "opencode", libc.tool, "bun") + " owned-child:/opt/factory/opencode/bun",
				"exec --user 0:0 owned-child chmod 0555 /opt/factory/opencode/bun",
			}
			verify := "exec --interactive --user 0:0 owned-child /tmp/factory-runtime-connector-1 opencode-verify --libc " + libc.tool
			first := append(append([]string{}, want...), verify, verify,
				"exec --user 0:0 owned-child /tmp/factory-runtime-connector-1 opencode-reset")
			reuse := append(append([]string{}, want[:7]...), verify)
			var expected []string
			for invocation := 1; invocation <= 2; invocation++ {
				if err := injectTestApprovedTools(t, context.Background(), assignment, "owned-child"); err != nil {
					t.Fatal(err)
				}
				content, err := os.ReadFile(filepath.Join(directory, "commands"))
				if err != nil {
					t.Fatal(err)
				}
				if probes := strings.Count(string(content), "ldd --version"); probes != invocation {
					t.Fatalf("got %d libc probes after %d invocation(s), want %d", probes, invocation, invocation)
				}
				if invocation == 1 {
					expected = append(expected, first...)
				} else {
					expected = append(expected, reuse...)
				}
				got := strings.Split(strings.TrimSpace(string(content)), "\n")
				slices.Sort(got)
				slices.Sort(expected)
				if !reflect.DeepEqual(got, expected) {
					t.Fatalf("pinned tool selection or placement changed:\ngot %v\nwant %v", got, expected)
				}
			}
		})
	}
}

func TestApprovedToolsLibcProbeIsCapabilityScoped(t *testing.T) {
	for _, capabilities := range []struct {
		name                           string
		channels                       []Channel
		languages, agent, verification bool
	}{
		{name: "none"},
		{name: "unrelated", channels: []Channel{{Name: "app", Kind: "app"}}},
		{name: "languages", channels: []Channel{{Name: "ide", Kind: "ide"}}, languages: true},
		{name: "agent", channels: []Channel{{Name: "agent", Kind: "agent"}}, agent: true},
		{name: "verification", channels: []Channel{{Name: "verification", Kind: "verification"}}, verification: true},
		{name: "all", channels: injectionTimingAssignment().Channels, languages: true, agent: true, verification: true},
	} {
		t.Run(capabilities.name, func(t *testing.T) {
			directory, timeline := injectionTimingFixture(t)
			assignment := injectionTimingAssignment()
			assignment.Channels = capabilities.channels
			if err := injectTestApprovedTools(t, context.Background(), assignment, "owned-child"); err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(filepath.Join(directory, "commands"))
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			commands := string(content)
			if strings.Contains(commands, "/language-tools/") != capabilities.languages ||
				strings.Contains(commands, "/opencode") != capabilities.agent ||
				strings.Contains(commands, "/forgejo-runner") != capabilities.verification {
				t.Fatalf("injection dispatched an unrequested tool or omitted a requested tool: %s", commands)
			}
			wantProbes := 0
			wantPhase := ""
			if capabilities.languages {
				wantProbes = 1
				wantPhase = "phase:language-tools-probe"
			} else if capabilities.agent {
				wantProbes = 1
				wantPhase = "phase:opencode-probe"
			}
			entries := timeline()
			phases := 0
			for _, entry := range entries {
				if entry == "phase:language-tools-probe" || entry == "phase:opencode-probe" {
					phases++
				}
			}
			if strings.Count(commands, "ldd --version") != wantProbes || phases != wantProbes ||
				(wantPhase != "" && !slices.Contains(entries, wantPhase)) {
				t.Fatalf("libc probe or phase was not capability-scoped: %v", entries)
			}
		})
	}
}

func TestApprovedToolsLibcValidationPreservesErrorsAndStopsInjection(t *testing.T) {
	for _, capabilities := range []struct {
		name     string
		channels []Channel
		phase    string
		error    string
	}{
		{"languages", []Channel{{Name: "ide", Kind: "ide"}}, "language-tools-probe", "Language tools require a supported glibc or musl development container"},
		{"agent", []Channel{{Name: "agent", Kind: "agent"}}, "opencode-probe", "OpenCode requires a supported glibc or musl development container"},
		{"both-agent-first", []Channel{{Name: "agent", Kind: "agent"}, {Name: "ide", Kind: "ide"}}, "language-tools-probe", "Language tools require a supported glibc or musl development container"},
		{"all", injectionTimingAssignment().Channels, "language-tools-probe", "Language tools require a supported glibc or musl development container"},
	} {
		t.Run(capabilities.name, func(t *testing.T) {
			for _, canceled := range []bool{false, true} {
				_, timeline := injectionTimingFixture(t)
				t.Setenv("FACTORY_INJECTION_LIBC", "unsupported-private-tool-diagnostic")
				t.Setenv("FACTORY_INJECTION_LIBC_STATUS", "23")
				assignment := injectionTimingAssignment()
				assignment.Channels = capabilities.channels
				ctx, cancel := context.WithCancel(context.Background())
				if canceled {
					cancel()
				}
				err := injectTestApprovedTools(t, ctx, assignment, "owned-child")
				cancel()
				if err == nil || err.Error() != capabilities.error {
					t.Fatalf("libc validation changed its error (canceled=%v): %v", canceled, err)
				}
				var want []string
				if !canceled {
					want = append(want, "command:libc-probe")
				}
				want = append(want, "phase:"+capabilities.phase)
				if got := timeline(); !reflect.DeepEqual(got, want) {
					t.Fatalf("failed probe lost timing or dispatched a later command: got %v want %v", got, want)
				}
			}
		})
	}
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

func TestInjectionTimingSuccessPreservesCommandOrderAndTotal(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	finish := startupPhase("tool-injection")
	err := injectTestChild(t, context.Background(), injectionTimingAssignment(), devcontainerResult{
		ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
	}, "private-child-token")
	finish()
	if err != nil {
		t.Fatal("stubbed injection failed")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		entries := timeline()
		if slices.Contains(entries, "child-exited") && slices.Contains(entries, "phase:language-tools-publish") {
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
	for _, entry := range requiredInjectionTimeline(timeline()) {
		// Start measures process launch, not completion of the child process.
		if entry != "command:child-start" && entry != "child-exited" {
			got = append(got, entry)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("injection phase/command order changed:\ngot %v\nwant %v", got, want)
	}
	var optional []string
	for _, entry := range timeline() {
		if strings.HasPrefix(entry, "command:languages-") ||
			(strings.HasPrefix(entry, "phase:language-tools-") && entry != "phase:language-tools-probe") {
			optional = append(optional, entry)
		}
	}
	wantOptional := []string{
		"command:languages-setup", "phase:language-tools-setup",
		"command:languages-tree", "phase:language-tools-tree-copy",
		"command:languages-runtime", "phase:language-tools-runtime-copy",
		"command:languages-publish", "phase:language-tools-publish",
	}
	if !reflect.DeepEqual(optional, wantOptional) {
		t.Fatalf("language runtime was published before the complete pinned bundle: %v", optional)
	}
}

func TestOptionalLanguageFailureDoesNotFailRequiredInjection(t *testing.T) {
	for _, step := range []struct{ command, phase string }{
		{"languages-setup", "language-tools-setup"},
		{"languages-tree", "language-tools-tree-copy"},
		{"languages-runtime", "language-tools-runtime-copy"},
		{"languages-publish", "language-tools-publish"},
	} {
		t.Run(step.command, func(t *testing.T) {
			_, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_FAIL", step.command)
			preparation, err := injectApprovedTools(injectionTimingContext(t.Context()), injectionTimingAssignment(), "owned-child", "/tmp/factory-runtime-connector-1")
			defer preparation.stop()
			<-preparation.done
			if err != nil || preparation.err == nil {
				t.Fatalf("optional failure either failed required tools or claimed language availability: required=%v language=%v", err, preparation.err)
			}
			entries := timeline()
			if !slices.Contains(entries, "phase:"+step.phase) ||
				!slices.Contains(entries, "phase:opencode-permissions") ||
				!slices.Contains(entries, "phase:verification-runner-permissions") {
				t.Fatalf("language failure hid its own timing or prevented required tool setup: %v", entries)
			}
			if step.command != "languages-publish" && slices.Contains(entries, "command:languages-publish") {
				t.Fatal("failed language copies published a partial runtime")
			}
		})
	}
}

func TestOptionalLanguageProbeFailureStillStartsChild(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	t.Setenv("FACTORY_INJECTION_FAIL", "libc-probe")
	assignment := injectionTimingAssignment()
	assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}}
	if err := injectTestChild(t, t.Context(), assignment, devcontainerResult{
		ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
	}, "private-child-token"); err != nil {
		t.Fatalf("unavailable optional language libc failed Child startup: %v", err)
	}
	if entries := timeline(); !slices.Contains(entries, "phase:child-start") ||
		slices.Contains(entries, "command:languages-setup") {
		t.Fatalf("unsupported libc copied language tools or blocked Child: %v", entries)
	}
}

func TestLanguageStreamingStartFailureReapsConsumer(t *testing.T) {
	directory, timeline := injectionTimingFixture(t)
	if err := os.Remove(filepath.Join(directory, "tar")); err != nil {
		t.Fatal(err)
	}
	err := streamLanguageToolContents(t.Context(), "owned-child", languageToolsRoot+"/node_modules", languageToolsRoot+"/node_modules")
	if !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("missing producer did not retain its start error: %v", err)
	}
	raw, err := os.ReadFile(os.Getenv("FACTORY_INJECTION_REACHED") + ".languages-tree.consumer")
	pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || parseErr != nil || pid <= 0 || syscall.Kill(pid, 0) != syscall.ESRCH {
		t.Fatal("producer start failure did not close stdin and reap its consumer")
	}
	if got := timeline(); !reflect.DeepEqual(got, []string{"command:languages-tree"}) {
		t.Fatalf("failed producer dispatched later work: %v", got)
	}
}

func TestChildInjectionCancellationJoinsConcurrentOwnedToolCopies(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	t.Setenv("FACTORY_INJECTION_CANCEL", "languages-tree opencode-server")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		stop, err := injectChild(injectionTimingContext(ctx), injectionTimingAssignment(), devcontainerResult{
			ContainerID: "owned-child", RemoteUser: "node", RemoteWorkspaceFolder: "/workspace/project",
		}, "private-child-token")
		stop()
		done <- err
	}()
	joined := false
	defer func() {
		cancel()
		if !joined {
			<-done
		}
	}()
	var pids []int
	for _, step := range []string{"languages-tree", "languages-tree.consumer", "opencode-server"} {
		path := os.Getenv("FACTORY_INJECTION_REACHED") + "." + step
		for deadline := time.Now().Add(2 * time.Second); ; {
			raw, err := os.ReadFile(path)
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
			if err == nil && parseErr == nil && pid > 0 {
				pids = append(pids, pid)
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("fixture did not block both real owned tool-copy processes")
			}
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	select {
	case err := <-done:
		joined = true
		if err == nil {
			t.Fatal("canceled required copy claimed successful Child startup")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not join both owned tool-copy processes")
	}
	for _, pid := range pids {
		if syscall.Kill(pid, 0) != syscall.ESRCH {
			t.Fatal("cancellation returned without reaping an owned tool-copy process")
		}
	}
	entries := timeline()
	for _, later := range []string{"command:languages-runtime", "command:languages-publish", "command:opencode-runtime", "phase:child-start", "command:child-start"} {
		if slices.Contains(entries, later) {
			t.Fatalf("canceled preparation continued after Stop: %s", later)
		}
	}
}

func TestInjectionTimingFailureEndsAtTheFailedCommand(t *testing.T) {
	for index, failed := range injectionTimingCommands {
		t.Run(failed.command, func(t *testing.T) {
			_, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_FAIL", failed.command)
			err := injectTestChild(t, context.Background(), injectionTimingAssignment(), devcontainerResult{
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
			if got := requiredInjectionTimeline(timeline()); !reflect.DeepEqual(got, want) {
				t.Fatalf("failed operation lost timing or dispatched a later step:\ngot %v\nwant %v", got, want)
			}
		})
	}
}

func TestInjectionTimingCancellationFinishesPendingCommand(t *testing.T) {
	for _, step := range []struct{ command, phase string }{
		{"libc-probe", "language-tools-probe"},
		{"opencode-server", "opencode-server-copy"},
	} {
		t.Run(step.command, func(t *testing.T) {
			directory, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_CANCEL", step.command)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- injectTestChild(t, ctx, injectionTimingAssignment(), devcontainerResult{
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
					t.Fatal("stub did not enter the selected command")
				}
				time.Sleep(time.Millisecond)
			}
			observedAt := time.Now()
			cancel()
			select {
			case err := <-done:
				if err == nil || !errors.Is(ctx.Err(), context.Canceled) {
					t.Fatal("command cancellation was lost")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("canceled command was not joined")
			}
			entries := requiredInjectionTimeline(timeline())
			if len(entries) == 0 || entries[len(entries)-1] != "phase:"+step.phase ||
				slices.Contains(entries, "phase:child-start") || slices.Contains(entries, "command:child-start") {
				t.Fatal("canceled command lost its completion timing or started the child")
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
					t.Fatal("timing did not include its pending command before cancellation")
				}
				measured = true
			}
			if !measured {
				t.Fatal("pending command did not emit its phase timing")
			}
		})
	}
}

func TestInjectionTimingOpenCodeProbeFailure(t *testing.T) {
	_, timeline := injectionTimingFixture(t)
	t.Setenv("FACTORY_INJECTION_FAIL", "libc-probe")
	assignment := injectionTimingAssignment()
	assignment.Channels = []Channel{{Name: "agent", Kind: "agent"}}
	err := injectTestApprovedTools(t, context.Background(), assignment, "owned-child")
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
			err := injectTestChild(t, context.Background(), assignment, devcontainerResult{
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
	err := injectTestChild(t, context.Background(), assignment, devcontainerResult{
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
