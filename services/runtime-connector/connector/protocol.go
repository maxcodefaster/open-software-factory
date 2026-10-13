package connector

import "net/http"

const (
	ConnectorProtocol = "factory-runtime-connector-v1"
	maxMessageBytes   = 8 << 20
	maxControlBytes   = 12 << 20
	maxResponseBytes  = 16 << 20
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
	TerminalRevision     *uint64           `json:"terminalRevision,omitempty"`
	Channels             []Channel         `json:"channels,omitempty"`
	StreamID             string            `json:"streamId,omitempty"`
	Channel              string            `json:"channel,omitempty"`
	Method               string            `json:"method,omitempty"`
	Path                 string            `json:"path,omitempty"`
	Headers              map[string]string `json:"headers,omitempty"`
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
	CommitSHA            string            `json:"commitSha,omitempty"`
	RepositoryURL        string            `json:"repositoryURL,omitempty"`
	RemoteSHA            string            `json:"remoteSha,omitempty"`
	CommitMessage        string            `json:"commitMessage,omitempty"`
	AuthorName           string            `json:"authorName,omitempty"`
	AuthorEmail          string            `json:"authorEmail,omitempty"`
	Username             string            `json:"username,omitempty"`
	Password             string            `json:"password,omitempty"`
}

func flattenHeaders(headers http.Header) map[string]string {
	result := make(map[string]string, len(headers))
	for name, values := range headers {
		if len(values) > 0 {
			result[name] = values[0]
		}
	}
	return result
}
