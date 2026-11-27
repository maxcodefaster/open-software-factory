package language

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

func nativeLanguageFixture(t *testing.T, glibc, musl string) (string, protocol.Assignment, string) {
	t.Helper()
	root := t.TempDir()
	log := filepath.Join(t.TempDir(), "probes")
	t.Setenv("NATIVE_LANGUAGE_PROBE_LOG", log)
	for path, content := range map[string]string{
		"glibc/node": glibc,
		"musl/node":  musl,
		"node_modules/typescript-language-server/lib/cli.mjs": "packaged server fixture",
		"node_modules/pyright/langserver.index.js":            "packaged server fixture",
	} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	assignment.RuntimeEnvironment = map[string]string{"VIRTUAL_ENV": "/project/.venv", "PYTHONPATH": "/project/deps"}
	return root, assignment, log
}

func TestNativeLanguageCommandUsesMountedLibcVariantsAndProjectEnvironment(t *testing.T) {
	for _, language := range []string{"typescript", "python"} {
		for _, libc := range []string{"glibc", "musl"} {
			t.Run(language+"/"+libc, func(t *testing.T) {
				success := "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$NATIVE_LANGUAGE_PROBE_LOG\"\nexit 0\n"
				glibc := success
				if libc == "musl" {
					glibc = strings.Replace(success, "exit 0", "exit 1", 1)
				}
				root, assignment, log := nativeLanguageFixture(t, glibc, success)
				t.Setenv("PATH", "/project/bin")
				t.Setenv("NODE_OPTIONS", "--require=/project/hook.js")
				t.Setenv("LD_LIBRARY_PATH", "/project/lib")
				t.Setenv("VIRTUAL_ENV", "/wrong-image-default")
				command, err := nativeLanguageCommand(t.Context(), assignment, root, language)
				if err != nil {
					t.Fatal(err)
				}
				runtime := filepath.Join(root, libc)
				script := "typescript-language-server/lib/cli.mjs"
				if language == "python" {
					script = "pyright/langserver.index.js"
				}
				if command.Path != filepath.Join(runtime, "node") || command.Dir != assignment.WorkspaceFolder ||
					!reflect.DeepEqual(command.Args, []string{command.Path, filepath.Join(root, "node_modules", script), "--stdio"}) {
					t.Fatalf("wrong native execution: %#v", command)
				}
				for _, expected := range []string{"PATH=/project/bin", "VIRTUAL_ENV=/project/.venv", "PYTHONPATH=/project/deps", "LD_LIBRARY_PATH=" + runtime + "/lib:/project/lib"} {
					if !strings.Contains("\n"+strings.Join(command.Env, "\n")+"\n", "\n"+expected+"\n") {
						t.Fatalf("missing %s in %v", expected, command.Env)
					}
				}
				if strings.Contains(strings.Join(command.Env, "\n"), "NODE_OPTIONS=") {
					t.Fatal("Project loader options reached packaged Node")
				}
				probes, err := os.ReadFile(log)
				expected := filepath.Join(root, "glibc/node") + "\n"
				if libc == "musl" {
					expected += filepath.Join(root, "musl/node") + "\n"
				}
				if err != nil || string(probes) != expected {
					t.Fatalf("wrong libc probes: %q %v", probes, err)
				}
			})
		}
	}
}

func TestNativeLanguageCommandRejectsMissingToolsAndUnrunnableLibc(t *testing.T) {
	root, assignment, _ := nativeLanguageFixture(t, "#!/bin/sh\nexit 1\n", "#!/bin/sh\nexit 1\n")
	for _, language := range []string{"shell", "typescript", "python"} {
		if command, err := nativeLanguageCommand(t.Context(), assignment, root, language); err == nil || command != nil {
			t.Fatalf("accepted unavailable %s tools: %v", language, command)
		}
	}
	if err := os.Remove(filepath.Join(root, "node_modules/pyright/langserver.index.js")); err != nil {
		t.Fatal(err)
	}
	if _, err := nativeLanguageCommand(t.Context(), assignment, root, "python"); err == nil || !strings.Contains(err.Error(), "not packaged") {
		t.Fatalf("missing script was announced as usable: %v", err)
	}
	if command, err := nativeLanguageCommand(t.Context(), assignment, t.TempDir(), "typescript"); err == nil || command != nil {
		t.Fatal("missing image volume fell back to an injected runtime or Project Node")
	}
}

func TestNativeLanguageRuntimeProbesRespectWriterAdmissionAndCancellation(t *testing.T) {
	root, assignment, log := nativeLanguageFixture(t,
		"#!/bin/sh\nprintf started >> \"$NATIVE_LANGUAGE_PROBE_LOG\"\nexec /bin/sleep 30\n",
		"#!/bin/sh\nexit 0\n")
	gate := &writergate.Gate{}
	gate.SetFrozen(true)
	assignment.SetNativeWriters(gate)
	if _, err := nativeLanguageCommand(t.Context(), assignment, root, "python"); err == nil {
		t.Fatal("frozen Source writers admitted a language process")
	}
	if _, err := os.Stat(log); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("runtime probe bypassed writer admission")
	}
	gate.SetFrozen(false)
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := nativeLanguageCommand(ctx, assignment, root, "python"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("runtime probe did not retain cancellation: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("cancelled runtime probe was not reaped promptly")
	}
}
