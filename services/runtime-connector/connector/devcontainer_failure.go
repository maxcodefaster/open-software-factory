package connector

import (
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
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
var diagnosticAuthorization = regexp.MustCompile(`(?i)(authorization["']?\s*:\s*["']?(?:bearer|basic)\s+)[^\s"']+`)
var diagnosticToken = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b`)
var diagnosticAssignment = regexp.MustCompile(`(?i)\b[A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Z_]*=(?:"[^"]*"|'[^']*'|[^\s;]+)`)
var diagnosticTerminalEscape = regexp.MustCompile(`(?:\x1b\[|\x{009b})[0-?]*[ -/]*[@-~]`)
var diagnosticHTTPFailure = regexp.MustCompile(`(?i)\bHTTP[ /][45][0-9]{2}\b`)
var diagnosticJSONCredential = regexp.MustCompile(`(?i)("[^"\\]*(?:token|password|secret|credential|api[_-]?key|cookie|authorization)[^"\\]*"\s*:\s*")((?:\\.|[^"\\])*)(")`)

func devcontainerFailureLines(text string) []string {
	var failures []string
	text = diagnosticTerminalEscape.ReplaceAllString(text, "")
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", "\n"), "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "error") || strings.Contains(lower, "failed") ||
			strings.Contains(lower, "failure") || strings.Contains(lower, "curl: (") ||
			diagnosticHTTPFailure.MatchString(line) ||
			strings.Contains(lower, "not found") || strings.Contains(lower, "denied") ||
			strings.Contains(lower, "not permitted") || strings.Contains(lower, "privileges requested") ||
			strings.Contains(lower, "did not complete successfully") {
			failures = append(failures, line)
		}
	}
	return failures
}

func devcontainerProcessFailures(lines []string) (causes, processes []string) {
	for _, line := range lines {
		start := strings.Index(line, `process "`)
		end := strings.LastIndex(line, `" did not complete successfully:`)
		if start >= 0 && end > start {
			// A Dockerfile RUN can occupy the entire public diagnostic.
			// Retain the terminal status, not its repeated shell command,
			// and put the process's own error output ahead of this wrapper.
			line = line[:start] + "build process" + line[end+1:]
			processes = append(processes, line)
		} else {
			causes = append(causes, line)
		}
	}
	return causes, processes
}

func devcontainerFailureDiagnostic(stdout, stderr string, assignment Assignment) string {
	var summary []string
	for _, line := range strings.Split(stdout, "\n") {
		var result struct {
			Outcome     string `json:"outcome"`
			Description string `json:"description"`
			Message     string `json:"message"`
		}
		if json.Unmarshal([]byte(line), &result) == nil && result.Outcome == "error" {
			summary = append(summary, result.Description, result.Message)
		}
	}
	var raw strings.Builder
	var causes, fallback []string
	for _, line := range strings.Split(stderr, "\n") {
		var entry struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil {
			if entry.Type == "raw" {
				// Raw events are transport chunks, not complete lines. Join
				// before selecting causes or masking split credentials.
				raw.WriteString(entry.Text)
				continue
			}
			line = entry.Text
		}
		for _, failure := range devcontainerFailureLines(line) {
			lower := strings.ToLower(failure)
			if strings.Contains(lower, "command failed:") ||
				strings.Contains(lower, "failed to fetch control manifest") {
				fallback = append(fallback, failure)
			} else {
				causes = append(causes, failure)
			}
		}
	}
	tail := func(lines []string) []string {
		if len(lines) > 4 {
			lines = lines[len(lines)-4:]
		}
		lines = slices.Clone(lines)
		slices.Reverse(lines)
		return lines
	}
	// Preserve the actual build/process cause before repetitive CLI wrappers.
	// An optional control-manifest lookup is not the Compose build verdict.
	rawCauses, rawProcesses := devcontainerProcessFailures(devcontainerFailureLines(raw.String()))
	causes, processes := devcontainerProcessFailures(causes)
	details := append(tail(rawCauses), tail(causes)...)
	details = append(details, tail(rawProcesses)...)
	details = append(details, tail(processes)...)
	if len(details) == 0 {
		details = tail(fallback)
	}
	details = append(details, summary...)
	return redactRuntimeDiagnostic(strings.Join(details, " "), assignment)
}

func redactRuntimeDiagnostic(text string, assignment Assignment) string {
	return compactRuntimeDiagnostic(maskRuntimeDiagnostic(text, assignment))
}

func maskRuntimeDiagnostic(text string, assignment Assignment) string {
	text = diagnosticTerminalEscape.ReplaceAllString(text, "")
	// Process-local credentials, including the native Agent password, must not
	// escape into a retained failure through an App's startup output.
	var values []string
	for _, value := range assignment.RuntimeEnvironment {
		values = append(values, value)
	}
	for _, process := range assignment.Processes {
		for _, value := range process.Env {
			values = append(values, value)
		}
	}
	// A rolling tail or a selected error line can begin inside a multiline
	// secret. Retain no complete secret line merely because its prefix was
	// outside the bounded capture.
	for _, value := range slices.Clone(values) {
		if strings.ContainsAny(value, "\r\n") {
			values = append(values, strings.FieldsFunc(value, func(r rune) bool {
				return r == '\r' || r == '\n'
			})...)
		}
	}
	slices.SortFunc(values, func(a, b string) int { return len(b) - len(a) })
	for _, value := range values {
		if value == "" {
			continue
		}
		encoded, _ := json.Marshal(value)
		// Native App loggers can emit JSON rather than the CLI's text events.
		// Mask the escaped value before shortening that raw diagnostic too.
		jsonValue := string(encoded[1 : len(encoded)-1])
		for _, form := range []string{value, url.QueryEscape(value), url.PathEscape(value), jsonValue} {
			text = strings.ReplaceAll(text, form, "[REDACTED]")
		}
	}
	text = diagnosticCredentials.ReplaceAllString(text, "${1}[REDACTED]@")
	text = diagnosticAuthorization.ReplaceAllString(text, "${1}[REDACTED]")
	text = diagnosticToken.ReplaceAllString(text, "[REDACTED]")
	text = diagnosticJSONCredential.ReplaceAllString(text, "${1}[REDACTED]${3}")
	text = diagnosticAssignment.ReplaceAllStringFunc(text, func(value string) string {
		return strings.SplitN(value, "=", 2)[0] + "=[REDACTED]"
	})
	return text
}

func compactRuntimeDiagnostic(text string) string {
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
