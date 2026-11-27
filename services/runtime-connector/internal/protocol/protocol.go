package protocol

import "net/http"

const (
	ConnectorProtocol = "factory-runtime-connector-v1"
	MaxMessageBytes   = 8 << 20
	MaxControlBytes   = 12 << 20
	MaxResponseBytes  = 16 << 20
	// Match the response-only cookie bounds in Factory's Runtime Hub.
	MaxResponseCookies       = 128
	MaxResponseCookieBytes   = 64 << 10
	MaxAppAuthorizationBytes = 16 << 10
)

type Message struct {
	Type                 string            `json:"type"`
	Role                 string            `json:"role,omitempty"`
	AttemptID            string            `json:"runtimeAttemptId,omitempty"`
	Generation           uint64            `json:"generation,omitempty"`
	Phase                string            `json:"phase,omitempty"`
	Process              string            `json:"process,omitempty"`
	ProcessLabel         string            `json:"processLabel,omitempty"`
	ProcessState         string            `json:"processState,omitempty"`
	StartedAt            string            `json:"startedAt,omitempty"`
	ExitCode             *int              `json:"exitCode,omitempty"`
	TerminalID           string            `json:"terminalId,omitempty"`
	TerminalCount        *int              `json:"terminalCount,omitempty"`
	TerminalBusy         *int              `json:"terminalBusy,omitempty"`
	TerminalRevision     *uint64           `json:"terminalRevision,omitempty"`
	CommandCount         *int              `json:"commandCount,omitempty"`
	Channels             []Channel         `json:"channels,omitempty"`
	SourceEpoch          *uint64           `json:"sourceEpoch,omitempty"`
	StreamID             string            `json:"streamId,omitempty"`
	Channel              string            `json:"channel,omitempty"`
	Method               string            `json:"method,omitempty"`
	Path                 string            `json:"path,omitempty"`
	Headers              map[string]string `json:"headers,omitempty"`
	Cookies              []string          `json:"cookies,omitempty"`
	AppAuthorization     string            `json:"appAuthorization,omitempty"`
	Status               int               `json:"status,omitempty"`
	Data                 string            `json:"data,omitempty"`
	MessageType          int               `json:"messageType,omitempty"`
	Protocol             string            `json:"protocol,omitempty"`
	TheiaConnectionToken string            `json:"theiaConnectionToken,omitempty"`
	Code                 int               `json:"code,omitempty"`
	Error                string            `json:"error,omitempty"`
	OperationID          string            `json:"operationId,omitempty"`
	Action               string            `json:"action,omitempty"`
	Branch               string            `json:"branch,omitempty"`
	ExpectedSHA          string            `json:"expectedSha,omitempty"`
	MergeParentSHA       string            `json:"mergeParentSha,omitempty"`
	CommitSHA            string            `json:"commitSha,omitempty"`
	RepositoryURL        string            `json:"repositoryURL,omitempty"`
	RemoteSHA            string            `json:"remoteSha,omitempty"`
	CommitMessage        string            `json:"commitMessage,omitempty"`
	AuthorName           string            `json:"authorName,omitempty"`
	AuthorEmail          string            `json:"authorEmail,omitempty"`
	Username             string            `json:"username,omitempty"`
	Password             string            `json:"password,omitempty"`
}

type CommandRequest struct {
	ID      string            `json:"id"`
	Digest  string            `json:"digest"`
	Command string            `json:"command"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

type CommandRead struct {
	ID     string `json:"id"`
	Stdout uint64 `json:"stdout,omitempty"`
	Stderr uint64 `json:"stderr,omitempty"`
}

// State and identity are compact observations. Output is only a bounded in-memory tail.
type CommandView struct {
	ID          string `json:"id"`
	Digest      string `json:"digest"`
	State       string `json:"state"`
	PID         int    `json:"pid,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
	ExitCode    *int   `json:"exitCode,omitempty"`
	Stdout      []byte `json:"stdout,omitempty"`
	Stderr      []byte `json:"stderr,omitempty"`
	StdoutFrom  uint64 `json:"stdoutFrom"`
	StderrFrom  uint64 `json:"stderrFrom"`
	StdoutNext  uint64 `json:"stdoutNext"`
	StderrNext  uint64 `json:"stderrNext"`
	OutputLost  bool   `json:"outputLost"`
}

func ErrorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func ValidAppAuthorization(value string) bool {
	if len(value) > MaxAppAuthorizationBytes {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f || character > 0xff {
			return false
		}
	}
	return true
}

func ValidResponseCookies(cookies []string) bool {
	if len(cookies) > MaxResponseCookies {
		return false
	}
	total := 0
	for _, cookie := range cookies {
		total += len(cookie)
		if cookie == "" || total > MaxResponseCookieBytes {
			return false
		}
		for _, character := range cookie {
			if (character < 0x20 && character != '\t') || character == 0x7f {
				return false
			}
		}
	}
	return true
}

func FlattenHeaders(headers http.Header) map[string]string {
	result := make(map[string]string, len(headers))
	for name, values := range headers {
		if len(values) > 0 {
			result[name] = values[0]
		}
	}
	return result
}
