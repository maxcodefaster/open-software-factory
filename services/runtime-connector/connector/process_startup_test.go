package connector

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestFailedAppKeepsPlainCLIExplanationWithoutRequiringAnErrorKeyword(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{"APP_SECRET": "owned-plain-cli-secret"}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	code := 1
	manager.processes["app"].state = "failed"
	manager.processes["app"].exitCode = &code
	manager.recent["app"] = []byte("\x1b[31mERR_PNPM_BAD_PM_VERSION\x1b[0m Expected package manager 10, received 9; APP_SECRET=owned-plain-cli-secret\n")
	err := manager.startupFailure(assignment)
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
	assignment.Processes = []Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{"APP_SECRET": "owned\njson-secret"}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	content, err := json.Marshal(map[string]string{
		"level": "warn", "message": "Expected package manager 10", "context": "owned\njson-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.recent["app"] = content
	err = manager.startupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "Expected package manager 10") ||
		strings.Contains(err.Error(), "owned") || strings.Contains(err.Error(), "json-secret") ||
		!strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("structured App explanation leaked its escaped Environment value: %v", err)
	}
}

func TestPlainAppTailMasksWhitespaceAndPartialMultilineSecretsBeforeSelectingLines(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "app"}}
	assignment.RuntimeEnvironment = map[string]string{
		"SPACE_SECRET":     " owned-whitespace-secret ",
		"MULTILINE_SECRET": "owned-first\nowned-middle\nowned-last",
	}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
	manager.processes["app"].state = "failed"
	// Model an already bounded capture whose leading secret line was outside
	// the retained window. Plain CLI output intentionally has no error keyword.
	manager.recent["app"] = []byte("Package manager refused startup\nowned-middle\nowned-last\n owned-whitespace-secret \n")
	err := manager.startupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "Package manager refused startup") ||
		strings.Contains(err.Error(), "owned-") || !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("plain App tail exposed a trimmed or partial multiline credential: %v", err)
	}
}

func TestPlainAppJSONTailMasksAuthenticationEvenWhenItIsNotARuntimeVariable(t *testing.T) {
	assignment := validAssignment()
	assignment.Processes = []Process{{Name: "app"}}
	manager := newProcessManager(context.Background(), assignment, io.Discard)
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
	err = manager.startupFailure(assignment)
	if err == nil || !strings.Contains(err.Error(), "Expected package manager 10") ||
		strings.Contains(err.Error(), "owned-") {
		t.Fatalf("plain App JSON output exposed authentication material: %v", err)
	}
}
