package processes

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func validAssignment() protocol.Assignment {
	return protocol.Assignment{
		Version:               protocol.AssignmentVersion,
		RuntimeAttemptID:      "runtime-test",
		Generation:            1,
		WorkspaceFolder:       "/workspace/outer",
		RemoteWorkspaceFolder: "/workspace/project",
		RepositoryURL:         "file:///factory/source/project.bundle",
		RepositoryIdentity:    "20e65e28-8bad-4c05-a063-3b629808d549",
		Revision:              "main",
		ActorTemplatePath:     ".devcontainer/devcontainer.json",
		ControlURL:            "wss://factory.example.test/runtime/connect",
		Channels: []protocol.Channel{{
			Name:       "app",
			Kind:       "app",
			Target:     "http://127.0.0.1:4300",
			HealthPath: "/health",
		}},
	}
}

func TestDevcontainerFailureKeepsTheActualComposeSchemaRejection(t *testing.T) {
	cause := "validating /tmp/devcontainercli-root/docker-compose/owned.yml: services.workspace.cache_from false schema"
	detail := DevcontainerFailureDiagnostic("", cause+"\nError: Command failed: docker compose build", protocol.Assignment{})
	if !strings.Contains(detail, "services.workspace.cache_from false schema") {
		t.Fatalf("Compose's actual schema rejection was replaced by the CLI wrapper: %s", detail)
	}
}

func TestDevcontainerBuildCauseOnStdoutIsNotReplacedByTheComposeWrapper(t *testing.T) {
	for _, format := range []string{"text", "raw JSON"} {
		t.Run(format, func(t *testing.T) {
			cause := "ERROR: failed to solve: actual-builder-cause-on-stdout; GH_TOKEN=owned-private-value\n"
			if format == "raw JSON" {
				encoded, err := json.Marshal(map[string]string{"type": "raw", "text": cause})
				if err != nil {
					t.Fatal(err)
				}
				cause = string(encoded) + "\n"
			}
			stdout := cause + `{"outcome":"error","description":"An error occurred building the Docker Compose images.","message":"Command failed: docker compose build"}`
			detail := DevcontainerFailureDiagnostic(stdout, "Error: Command failed: docker compose build", protocol.Assignment{
				RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"},
			})
			if !strings.Contains(detail, "actual-builder-cause-on-stdout") ||
				strings.Contains(detail, "owned-private-value") || len(detail) > 1024 {
				t.Fatalf("stdout build cause was lost or not safely bounded: %s", detail)
			}
		})
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
	detail := DevcontainerFailureDiagnostic(stdout, stderr, protocol.Assignment{
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
	detail := DevcontainerFailureDiagnostic(
		`{"outcome":"error","description":"An error occurred building the Docker Compose images."}`,
		stderr, protocol.Assignment{},
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
	detail := DevcontainerFailureDiagnostic(
		`{"outcome":"error","description":"An error occurred building the Docker Compose images."}`,
		stderr, protocol.Assignment{RuntimeEnvironment: map[string]string{"GH_TOKEN": "owned-private-value"}},
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
	detail := DevcontainerFailureDiagnostic("", "ERROR: failed to solve: process \"/bin/sh -c "+
		command+"\" did not complete successfully: exit code: 137\n", protocol.Assignment{})
	if !strings.Contains(detail, "exit code: 137") || strings.Contains(detail, "ordinary output") {
		t.Fatalf("a silent process lost its terminal exit status: %s", detail)
	}
}

func TestDevcontainerDiagnosticKeepsCurlProtocolFailure(t *testing.T) {
	stderr := "#5 6.372 curl: (18) transfer closed with 85888 bytes remaining to read\n" +
		"#5 ERROR: process \"/bin/sh -c curl --output /tmp/tool https://example.test/tool\" " +
		"did not complete successfully: exit code: 18\n"
	detail := DevcontainerFailureDiagnostic("", stderr, protocol.Assignment{})
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
	detail := DevcontainerFailureDiagnostic("", stderr, protocol.Assignment{
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
	detail := DevcontainerFailureDiagnostic("", strings.Repeat("ERROR: failed 值 ", 500)+
		"\nERROR: Authorization: Bearer owned-authorization", protocol.Assignment{})
	if len(detail) > 1024 || !utf8.ValidString(detail) ||
		strings.Contains(detail, "owned-authorization") {
		t.Fatalf("unsafe bounded diagnostic: %q", detail)
	}
}
