package connector

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Keep only an ephemeral tail, not an unbounded build transcript.
type devcontainerFailureOutput struct {
	data      []byte
	truncated bool
}

func (output *devcontainerFailureOutput) Write(data []byte) (int, error) {
	const limit = 32 * 1024
	length := len(data)
	output.data = append(output.data, data...)
	if len(output.data) > limit {
		output.data = append([]byte(nil), output.data[len(output.data)-limit:]...)
		output.truncated = true
	}
	return length, nil
}

func (output *devcontainerFailureOutput) String() string {
	text := string(output.data)
	if output.truncated {
		// Never publish a partial leading line, which could split a secret.
		if index := strings.IndexByte(text, '\n'); index >= 0 {
			return text[index+1:]
		}
		return ""
	}
	return text
}

var diagnosticCredentials = regexp.MustCompile(`(?i)(https?://)[^\s/@]+@`)
var diagnosticAuthorization = regexp.MustCompile(`(?i)(authorization:\s*(?:bearer|basic)\s+)\S+`)
var diagnosticToken = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b`)
var diagnosticAssignment = regexp.MustCompile(`\b[A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Z_]*=(?:"[^"]*"|'[^']*'|[^\s;]+)`)

func devcontainerFailureDiagnostic(stdout, stderr string, assignment Assignment) string {
	var details []string
	for _, line := range strings.Split(stdout, "\n") {
		var result struct {
			Outcome     string `json:"outcome"`
			Description string `json:"description"`
			Message     string `json:"message"`
		}
		if json.Unmarshal([]byte(line), &result) == nil && result.Outcome == "error" {
			details = append(details, result.Description, result.Message)
		}
	}
	var failures []string
	for _, line := range strings.Split(stderr, "\n") {
		var entry struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil {
			line = entry.Text
		}
		lower := strings.ToLower(line)
		if strings.Contains(lower, "error") || strings.Contains(lower, "failed") ||
			strings.Contains(lower, "not found") || strings.Contains(lower, "denied") {
			failures = append(failures, line)
		}
	}
	if len(failures) > 4 {
		failures = failures[len(failures)-4:]
	}
	details = append(details, failures...)
	text := strings.Join(details, " ")
	for _, value := range assignment.RuntimeEnvironment {
		if value == "" {
			continue
		}
		for _, form := range []string{value, url.QueryEscape(value), url.PathEscape(value)} {
			text = strings.ReplaceAll(text, form, "[REDACTED]")
		}
	}
	text = diagnosticCredentials.ReplaceAllString(text, "${1}[REDACTED]@")
	text = diagnosticAuthorization.ReplaceAllString(text, "${1}[REDACTED]")
	text = diagnosticToken.ReplaceAllString(text, "[REDACTED]")
	text = diagnosticAssignment.ReplaceAllStringFunc(text, func(value string) string {
		return strings.SplitN(value, "=", 2)[0] + "=[REDACTED]"
	})
	text = strings.Map(func(value rune) rune {
		if unicode.IsControl(value) {
			return ' '
		}
		return value
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 1024 {
		text = text[:1021]
		for !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
		text += "..."
	}
	return text
}
