package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDevcontainerBuildCauseSurvivesLargeCLIRawTransportEvent(t *testing.T) {
	directory := t.TempDir()
	text := strings.Repeat("ordinary build progress\n", 4096) +
		"ERROR: failed to solve: actual-builder-cause; GH_TOKEN=owned-private-value\n"
	raw, err := json.Marshal(map[string]string{"type": "raw", "text": text})
	if err != nil {
		t.Fatal(err)
	}
	jsonPath, textPath := filepath.Join(directory, "json.log"), filepath.Join(directory, "text.log")
	if err := os.WriteFile(jsonPath, append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(textPath, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(`#!/bin/sh
case " $* " in
  *" --log-format text "*) cat %q >&2 ;;
  *) cat %q >&2 ;;
esac
printf '%%s\n' '{"type":"text","text":"Error: Command failed: docker compose build"}' >&2
printf '%%s\n' '{"outcome":"error","description":"An error occurred building the Docker Compose images.","message":"Command failed: docker compose build"}'
exit 1
`, textPath, jsonPath)
	for name, content := range map[string]string{
		"docker": "#!/bin/sh\nexit 0\n", "devcontainer": script,
	} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err = startDevcontainer(context.Background(), Assignment{
		WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
		ComposeProjectName: "owned_transport", RuntimeAttemptID: "owned-transport", Generation: 1,
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if err == nil || !strings.Contains(err.Error(), "actual-builder-cause") {
		t.Fatalf("bounded diagnostic dropped the entire oversized raw JSON event: %v", err)
	}
	if strings.Contains(err.Error(), "owned-private-value") || len(err.Error()) > 1200 {
		t.Fatalf("build cause is not bounded and redacted: %v", err)
	}
}

func TestDevcontainerFailureKeepsBoundedRedactedCause(t *testing.T) {
	directory := t.TempDir()
	scripts := map[string]string{
		"docker": "#!/bin/sh\nexit 0\n",
		"devcontainer": `#!/bin/sh
printf '%s\n' '{"outcome":"error","description":"An error occurred building the container."}'
printf '%s\n' '{"type":"text","text":"ERROR: failed to solve: package installation failed; GH_TOKEN=owned-private-value; https://user:owned-private-value@example.test/archive"}' >&2
exit 1
`,
	}
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := startDevcontainer(context.Background(), Assignment{
		WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
		ComposeProjectName: "owned_diagnostic", RuntimeAttemptID: "owned-diagnostic", Generation: 1,
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if err == nil || !strings.Contains(err.Error(), "package installation failed") {
		t.Fatalf("lost the actual Dev Containers CLI failure: %v", err)
	}
	if strings.Contains(err.Error(), "owned-private-value") || strings.Contains(err.Error(), "user:") {
		t.Fatalf("diagnostic exposed credentials: %v", err)
	}
	if len(err.Error()) > 1200 {
		t.Fatalf("unbounded public diagnostic: %d bytes", len(err.Error()))
	}
}

func TestDevcontainerConfigurationFailureKeepsBoundedRedactedCause(t *testing.T) {
	directory := t.TempDir()
	script := `#!/bin/sh
printf '%s\n' '{"type":"text","text":"Error: metadata lookup failed for the Dockerfile base image; GH_TOKEN=owned-private-value; https://user:owned-private-value@example.test/archive"}' >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	_, err := validateDevcontainer(context.Background(), Assignment{
		WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if err == nil || !strings.Contains(err.Error(), "metadata lookup failed") {
		t.Fatalf("lost the actual configuration failure: %v", err)
	}
	if strings.Contains(err.Error(), "owned-private-value") || strings.Contains(err.Error(), "user:") {
		t.Fatalf("configuration diagnostic exposed credentials: %v", err)
	}
	if len(err.Error()) > 1200 {
		t.Fatalf("unbounded configuration diagnostic: %d bytes", len(err.Error()))
	}
}

func TestDevcontainerDiagnosticPrioritizesBuildCauseOverWrapperAndControlWarning(t *testing.T) {
	stdout := `{"outcome":"error","description":"An error occurred building the Docker Compose images.","message":"Command failed: docker compose build"}`
	stderr := `{"type":"raw","text":"#8 ERROR: failed to solve: process apt-get update did not complete successfully: exit code: 100; GH_TOKEN=owned-private-value\n"}
{"type":"text","text":"Error: Command failed: docker compose build"}
{"type":"text","text":"Command failed: docker compose build"}
{"type":"text","text":"Error: Command failed: docker compose build"}
{"type":"text","text":"Command failed: docker compose build"}
{"type":"text","text":"Failed to fetch control manifest: getaddrinfo EAI_AGAIN containers.dev"}
`
	detail := devcontainerFailureDiagnostic(stdout, stderr, Assignment{
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if !strings.HasPrefix(detail, "#8 ERROR: failed to solve: process apt-get update") {
		t.Fatalf("the actual build cause was replaced by wrappers or an ancillary lookup: %s", detail)
	}
	if strings.Contains(detail, "owned-private-value") {
		t.Fatal("prioritized build cause exposed a credential")
	}
}

func TestDevcontainerDiagnosticKeepsTerminalBakeEntitlementRefusal(t *testing.T) {
	stderr := `[old] Error fetching image details: Could not parse image name; subsequent pull succeeded
[new] additional privileges requested: pass "--allow=fs.read=/tmp/devcontainercli-root/features/Dockerfile-with-features" to grant requested privileges
Error: Command failed: docker compose build
`
	detail := devcontainerFailureDiagnostic(
		`{"outcome":"error","description":"An error occurred building the Docker Compose images."}`,
		stderr, Assignment{},
	)
	if !strings.HasPrefix(detail, "[new] additional privileges requested:") ||
		!strings.Contains(detail, "Dockerfile-with-features") {
		t.Fatalf("a recovered metadata warning hid the actual terminal build refusal: %s", detail)
	}
}

func TestDevcontainerDiagnosticKeepsInnerFailureBeforeLongBuildProcess(t *testing.T) {
	command := strings.Repeat(`curl --fail "https://example.test/tool"; `, 100)
	stderr := "#8 44.6 curl: (18) Send failure: Broken pipe; GH_TOKEN=owned-private-value\n" +
		"#8 ERROR: process \"/bin/sh -c " + command +
		"\" did not complete successfully: exit code: 18\n" +
		"ERROR: failed to solve: process \"/bin/sh -c " + command +
		"\" did not complete successfully: exit code: 18\n" +
		"Error: Command failed: docker compose build\n"
	detail := devcontainerFailureDiagnostic(
		`{"outcome":"error","description":"An error occurred building the Docker Compose images."}`,
		stderr, Assignment{RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"}},
	)
	if !strings.HasPrefix(detail, "#8 44.6 curl: (18) Send failure: Broken pipe; GH_TOKEN=[REDACTED]") ||
		!strings.Contains(detail, "exit code: 18") || strings.Contains(detail, "owned-private-value") {
		t.Fatalf("the Dockerfile command hid the actual inner failure or exit status: %s", detail)
	}
	if strings.Contains(detail, "https://example.test/tool") || len(detail) > 1024 {
		t.Fatalf("the compact diagnostic retained an oversized build command: %s", detail)
	}
}

func TestDevcontainerDiagnosticKeepsCompactProcessFailureWithoutInnerOutput(t *testing.T) {
	command := strings.Repeat(`printf "ordinary output"; `, 100)
	detail := devcontainerFailureDiagnostic("", "ERROR: failed to solve: process \"/bin/sh -c "+
		command+"\" did not complete successfully: exit code: 137\n", Assignment{})
	if !strings.Contains(detail, "exit code: 137") || strings.Contains(detail, "ordinary output") {
		t.Fatalf("a silent process lost its terminal exit status: %s", detail)
	}
}

func TestDevcontainerDiagnosticKeepsCurlProtocolFailure(t *testing.T) {
	stderr := "#5 6.372 curl: (18) transfer closed with 85888 bytes remaining to read\n" +
		"#5 ERROR: process \"/bin/sh -c curl --output /tmp/tool https://example.test/tool\" " +
		"did not complete successfully: exit code: 18\n"
	detail := devcontainerFailureDiagnostic("", stderr, Assignment{})
	if !strings.HasPrefix(detail, "#5 6.372 curl: (18) transfer closed") ||
		!strings.Contains(detail, "exit code: 18") {
		t.Fatalf("the native incomplete-transfer diagnostic was lost: %s", detail)
	}
}

func TestDevcontainerDiagnosticJoinsRawChunksBeforeRedaction(t *testing.T) {
	stderr := `{"type":"raw","text":"\u001b[31mERROR: failed to solve; GH_TOKEN=owned-"}
{"type":"text","text":"background observation"}
{"type":"raw","text":"private-value\u001b[0m\n"}
`
	detail := devcontainerFailureDiagnostic("", stderr, Assignment{
		RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
	})
	if !strings.HasPrefix(detail, "ERROR: failed to solve; GH_TOKEN=[REDACTED]") ||
		strings.Contains(detail, "private-value") || strings.Contains(detail, "owned-") ||
		strings.Contains(detail, "[31m") || strings.Contains(detail, "[0m") {
		t.Fatalf("raw transport chunks lost their cause or exposed split credentials: %s", detail)
	}
}

func TestDevcontainerFailureTailDropsPartialLines(t *testing.T) {
	var output devcontainerFailureOutput
	_, _ = output.Write([]byte(strings.Repeat("private-partial-line", 4000)))
	if output.String() != "" {
		t.Fatal("a truncated line could expose a partial secret")
	}
	_, _ = output.Write([]byte("\n{\"text\":\"ERROR: installation failed\"}\n"))
	if output.String() != "{\"text\":\"ERROR: installation failed\"}\n" {
		t.Fatalf("lost the following complete diagnostic: %q", output.String())
	}
}

func TestDevcontainerFailureDiagnosticIsBoundedAndMasksAuthorization(t *testing.T) {
	detail := devcontainerFailureDiagnostic("", strings.Repeat("ERROR: failed 值 ", 500)+
		"\nERROR: Authorization: Bearer owned-authorization", Assignment{})
	if len(detail) > 1024 || !utf8.ValidString(detail) ||
		strings.Contains(detail, "owned-authorization") {
		t.Fatalf("unsafe bounded diagnostic: %q", detail)
	}
}
