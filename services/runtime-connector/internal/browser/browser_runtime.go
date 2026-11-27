package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

var browserOwnerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var browserContainerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var errBrowserPagePending = errors.New("declared App navigation has not committed a page yet")

type RuntimeRequest struct {
	SessionID      string    `json:"sessionId"`
	TurnID         string    `json:"turnId"`
	AgentSessionID string    `json:"agentSessionId"`
	OwnerID        string    `json:"ownerId"`
	ExpiresAt      time.Time `json:"expiresAt"`
	Call           ToolCall  `json:"call"`
}

type browserRuntimeRequest = RuntimeRequest

// Local MCP protocol, page and recording state shared by the native Browser
// worker. Actor lifecycle and resource ownership belong to Factory/Substrate.
type browserRuntime struct {
	scope            browserRuntimeRequest
	directory        string
	ctx              context.Context
	cancel           context.CancelFunc
	mu               sync.Mutex
	authority        sync.Mutex
	expiresAt        time.Time
	input            io.WriteCloser
	responses        chan browserMCPReply
	command          *exec.Cmd
	wait             chan error
	sequence         int
	pageID           int
	app              string
	pendingApp       string
	closed           bool
	recordingStarted time.Time
	recordingEnded   time.Time
	recordingBytes   int64
	recordingIndexed bool
	recordingMu      sync.Mutex
	recordingFinish  *browserRecordingFinalization
	pagePath         string
}

func decodeBrowserRuntimeRequest(message protocol.Message, assignment protocol.Assignment) (browserRuntimeRequest, error) {
	invalid := errors.New("browser operation does not match its admitted execution scope")
	var request browserRuntimeRequest
	decoder := json.NewDecoder(strings.NewReader(message.Data))
	decoder.DisallowUnknownFields()
	if len(message.Data) > 16384 || decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF ||
		message.OperationID == "" || message.AttemptID != assignment.RuntimeAttemptID || message.Generation != assignment.Generation ||
		!protocol.IdentityPattern.MatchString(request.SessionID) || !protocol.IdentityPattern.MatchString(request.TurnID) ||
		!browserOwnerPattern.MatchString(request.OwnerID) || !strings.HasPrefix(request.AgentSessionID, "ses") ||
		len(request.AgentSessionID) > 200 {
		return request, invalid
	}
	if message.Action != "browser-close" && (time.Until(request.ExpiresAt) <= 0 || time.Until(request.ExpiresAt) > 30*time.Second) {
		return request, errors.New("browser execution lease is expired or exceeds its bound")
	}
	return request, nil
}

func SameScope(left, right RuntimeRequest) bool {
	return sameBrowserScope(left, right)
}

func sameBrowserScope(left, right browserRuntimeRequest) bool {
	return left.SessionID == right.SessionID && left.TurnID == right.TurnID &&
		left.OwnerID == right.OwnerID && left.AgentSessionID == right.AgentSessionID
}

// Bounded native tool output and read-only Source observations. This buffer does
// not dispatch commands or own an execution lifecycle.
type DockerOutput struct{ buffer bytes.Buffer }

type browserDockerOutput = DockerOutput

func (output *DockerOutput) Bytes() []byte { return output.buffer.Bytes() }
func (output *DockerOutput) Len() int      { return output.buffer.Len() }

func (output *DockerOutput) Write(data []byte) (int, error) {
	if output.Len()+len(data) > 128<<10 {
		return 0, errors.New("browser observation exceeds its bound")
	}
	return output.buffer.Write(data)
}

func writeBrowserAuthority(directory string, request browserRuntimeRequest) error {
	content, err := json.Marshal(browserAuthority{SessionID: request.SessionID, ExpiresAt: request.ExpiresAt})
	if err != nil {
		return err
	}
	if err := writeBrowserConfig(directory, "authority.json", content); err != nil {
		return errors.New("browser execution lease could not be written")
	}
	return nil
}

func (runtime *browserRuntime) renewAuthority(scope browserRuntimeRequest, renewal bool) error {
	// Browser calls hold mu while starting tools and awaiting MCP. Renewal must
	// progress independently or a slow authorized call expires itself.
	runtime.authority.Lock()
	defer runtime.authority.Unlock()
	if !sameBrowserScope(runtime.scope, scope) || runtime.ctx.Err() != nil {
		return errors.New("browser renewal does not own this execution")
	}
	if !runtime.expiresAt.IsZero() && !time.Now().Before(runtime.expiresAt) {
		return errors.New("browser execution authority ended")
	}
	// An explicit renewal may shorten authority. A call admitted before a newer
	// renewal must not overwrite it with its stale startup deadline.
	if renewal || runtime.expiresAt.IsZero() {
		runtime.expiresAt = scope.ExpiresAt
	}
	scope.ExpiresAt = runtime.expiresAt
	if err := os.MkdirAll(filepath.Join(runtime.directory, "config"), 0755); err != nil {
		return errors.New("browser socket/configuration directory unavailable")
	}
	return writeBrowserAuthority(runtime.directory, scope)
}

func (runtime *browserRuntime) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	runtime.sequence++
	if err := json.NewEncoder(runtime.input).Encode(map[string]any{
		"jsonrpc": "2.0", "id": runtime.sequence, "method": method, "params": params,
	}); err != nil {
		return nil, errors.New("browser tool dispatch was not confirmed")
	}
	select {
	case response, ok := <-runtime.responses:
		if !ok || response.ID != runtime.sequence || len(response.Error) != 0 {
			return nil, errors.New("browser tool outcome is unavailable; do not repeat a UI mutation without checking the App")
		}
		return response.Result, nil
	case <-ctx.Done():
		return nil, errors.New("browser tool exceeded its execution authority or deadline")
	case <-runtime.ctx.Done():
		return nil, errors.New("browser execution authority ended")
	}
}

func (runtime *browserRuntime) selectDeclaredPage(raw json.RawMessage, app string) error {
	var page struct {
		IsError    bool `json:"isError"`
		Structured struct {
			Pages []struct {
				ID       int    `json:"id"`
				URL      string `json:"url"`
				Selected bool   `json:"selected"`
			} `json:"pages"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(raw, &page) != nil || page.IsError {
		return errors.New("browser App page identity unavailable")
	}
	selected, pageID, pending := 0, 0, false
	for _, current := range page.Structured.Pages {
		if !current.Selected {
			continue
		}
		selected++
		if current.ID <= 0 {
			return errors.New("browser did not retain the declared App page identity")
		}
		if current.URL == "about:blank" {
			pending = true
		} else if !strings.HasPrefix(current.URL, "http://"+app+".factory.invalid/") {
			return errors.New("browser did not retain the declared App page identity")
		}
		pageID = current.ID
	}
	if selected != 1 {
		return errors.New("browser did not retain the declared App page identity")
	}
	if pending {
		return errBrowserPagePending
	}
	runtime.pageID, runtime.app, runtime.pendingApp = pageID, app, ""
	return nil
}
