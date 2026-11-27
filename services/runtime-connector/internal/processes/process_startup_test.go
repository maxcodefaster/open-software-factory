package processes

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func TestFailedAppKeepsPlainCLIExplanationWithoutRequiringAnErrorKeyword(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []protocol.Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{"APP_SECRET": "owned-plain-cli-secret"}
	manager := NewManager(context.Background(), assignment, io.Discard)
	code := 1
	manager.processes["app"].state = "failed"
	manager.processes["app"].exitCode = &code
	manager.recent["app"] = []byte("\x1b[31mERR_PNPM_BAD_PM_VERSION\x1b[0m Expected package manager 10, received 9; APP_SECRET=owned-plain-cli-secret\n")
	err := manager.StartupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "ERR_PNPM_BAD_PM_VERSION") ||
		!strings.Contains(err.Error(), "Expected package manager") ||
		!strings.Contains(err.Error(), "last App output") ||
		strings.Contains(err.Error(), "owned-plain-cli-secret") ||
		strings.Contains(err.Error(), "\x1b") || len(err.Error()) > 1200 {
		t.Fatalf("known failed App lost its bounded, sanitized CLI explanation: %v", err)
	}
}

func TestFailedAppJSONExplanationRedactsEscapedEnvironmentValues(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []protocol.Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{"APP_SECRET": "owned\njson-secret"}
	manager := NewManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	content, err := json.Marshal(map[string]string{
		"level": "warn", "message": "Expected package manager 10", "context": "owned\njson-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.recent["app"] = content
	err = manager.StartupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "Expected package manager 10") ||
		strings.Contains(err.Error(), "owned") || strings.Contains(err.Error(), "json-secret") ||
		!strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("structured App explanation leaked its escaped Environment value: %v", err)
	}
}

func TestPlainAppTailMasksWhitespaceAndPartialMultilineSecretsBeforeSelectingLines(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []protocol.Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{
		"SPACE_SECRET":     " owned-whitespace-secret ",
		"MULTILINE_SECRET": "owned-first\nowned-middle\nowned-last",
	}
	manager := NewManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	// Model an already bounded capture whose leading secret line was outside
	// the retained window. Plain CLI output intentionally has no error keyword.
	manager.recent["app"] = []byte("Package manager refused startup\nowned-middle\nowned-last\n owned-whitespace-secret \n")
	err := manager.StartupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "Package manager refused startup") ||
		strings.Contains(err.Error(), "owned-") || !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("plain App tail exposed a trimmed or partial multiline credential: %v", err)
	}
}

func TestPlainAppJSONTailMasksAuthenticationEvenWhenItIsNotARuntimeVariable(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []protocol.Process{{Name: "app"}}
	manager := NewManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	content, err := json.Marshal(map[string]string{
		"message":       "Expected package manager 10",
		"Authorization": "Bearer owned-user-session",
		"cookie":        "session=owned-cookie",
		"apiKey":        "owned-application-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.recent["app"] = content
	err = manager.StartupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "Expected package manager 10") ||
		strings.Contains(err.Error(), "owned-") {
		t.Fatalf("plain App JSON output exposed authentication material: %v", err)
	}
}

func TestStartupFailureRedactsProcessCredentialsBeforeTheShorterRuntimeValue(t *testing.T) {
	assignment := validAssignment()
	assignment.RuntimeEnvironment = map[string]string{"SHORT_SECRET": "owned-overlap"}
	assignment.Processes = []protocol.Process{{
		Name: "app", Env: map[string]string{"OPENCODE_PASSWORD": "owned-overlap-native-password"},
	}}
	manager := NewManager(context.Background(), assignment, io.Discard)
	code := 9
	manager.processes["app"].state = "failed"
	manager.processes["app"].exitCode = &code
	manager.recent["app"] = []byte("error: native=owned-overlap-native-password runtime=owned-overlap\n")
	err := manager.StartupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "code 9") ||
		strings.Contains(err.Error(), "owned-overlap") || strings.Contains(err.Error(), "native-password") ||
		!strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("startup cause leaked a process-local or overlapping credential: %v", err)
	}
}

func TestStartupFailureNeverPublishesThePartialLeadingLineOfItsRollingTail(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []protocol.Process{{Name: "app"}}
	manager := NewManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	tail := "error: partial-sensitive-value" + strings.Repeat("x", 32<<10) + "\nerror: missing configuration\n"
	manager.recent["app"] = []byte(tail[len(tail)-(32<<10):])
	err := manager.StartupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "missing configuration") ||
		strings.Contains(err.Error(), "partial-sensitive-value") || strings.Contains(err.Error(), "xxxx") {
		t.Fatalf("startup cause included an unverifiable partial line: %v", err)
	}
}
