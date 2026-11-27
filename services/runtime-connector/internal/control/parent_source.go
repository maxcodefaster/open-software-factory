package control

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

// Source uses the authenticated Parent socket, never an App port, Child token,
// arbitrary URL, or host listener. Each connection owns its streams; reconnect
// cancels old readers rather than delivering their replies on a new socket.
type ParentSourceStreams struct {
	handler http.Handler
	mu      sync.Mutex
	streams map[string]context.CancelFunc
}

func NewParentSourceStreams(handler http.Handler) *ParentSourceStreams {
	return &ParentSourceStreams{handler: handler}
}

// The existing Parent queue serializes Git, but browser work runs alongside it.
// A Source drain must wait for both and then reject every later writer until a
// new cold Parent starts. Keep this fence across control-socket reconnects and
// failed/lost drain replies; neither is authority to resume writing.
type ParentSourceFence struct {
	mu           sync.RWMutex
	checkpointID string
}

func (fence *ParentSourceFence) Wrap(handle func(context.Context, protocol.Message) protocol.Message) func(context.Context, protocol.Message) protocol.Message {
	return func(ctx context.Context, message protocol.Message) protocol.Message {
		denied := protocol.Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "Source writers are fenced for the recorded checkpoint"}
		if message.Action == "source-drain" {
			if message.OperationID == "" {
				return denied
			}
			fence.mu.Lock()
			defer fence.mu.Unlock()
			if fence.checkpointID != "" && fence.checkpointID != message.OperationID {
				return denied
			}
			fence.checkpointID = message.OperationID
			return handle(ctx, message)
		}
		fence.mu.RLock()
		defer fence.mu.RUnlock()
		if fence.checkpointID != "" {
			return denied
		}
		return handle(ctx, message)
	}
}

func ParentChannels(assignment protocol.Assignment) []protocol.Channel {
	if assignment.NativeSource() == nil {
		return nil
	}
	return []protocol.Channel{{Name: "source", Kind: "source"}}
}

func (streams *ParentSourceStreams) Close(id string) {
	streams.mu.Lock()
	defer streams.mu.Unlock()
	if cancel := streams.streams[id]; cancel != nil {
		cancel()
	}
}

func (streams *ParentSourceStreams) Start(ctx context.Context, control *Connection, message protocol.Message) {
	fail := func() {
		_ = control.Write(protocol.Message{Type: "stream-error", StreamID: message.StreamID, Error: "Source request is unavailable"})
	}
	parsed, err := url.ParseRequestURI(message.Path)
	if streams.handler == nil || message.Channel != "source" || message.StreamID == "" || len(message.StreamID) > 64 ||
		err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		!strings.HasPrefix(parsed.Path, "/v1/workspaces/") ||
		(message.Method != http.MethodPost && message.Method != http.MethodGet) {
		fail()
		return
	}
	body, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(body) > 4<<20 {
		fail()
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	streams.mu.Lock()
	if streams.streams == nil {
		streams.streams = make(map[string]context.CancelFunc)
	}
	_, duplicate := streams.streams[message.StreamID]
	if duplicate || len(streams.streams) >= 16 {
		streams.mu.Unlock()
		cancel()
		fail()
		return
	}
	streams.streams[message.StreamID] = cancel
	streams.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			streams.mu.Lock()
			delete(streams.streams, message.StreamID)
			streams.mu.Unlock()
		}()
		request, err := http.NewRequestWithContext(ctx, message.Method, "http://source.internal"+message.Path, bytes.NewReader(body))
		if err != nil {
			fail()
			return
		}
		// Only Factory's current writer authority crosses this boundary. In
		// particular, no browser cookies, Authorization or arbitrary headers.
		request.Header.Set("X-Factory-Writer-Epoch", message.Headers["x-factory-writer-epoch"])
		writer := &sourceControlWriter{control: control, streamID: message.StreamID, header: make(http.Header), ctx: ctx}
		streams.handler.ServeHTTP(writer, request)
		if !writer.started {
			writer.WriteHeader(http.StatusOK)
		}
		if !writer.failed {
			_ = control.Write(protocol.Message{Type: "stream-end", StreamID: message.StreamID})
		}
	}()
}

type sourceControlWriter struct {
	control  *Connection
	streamID string
	header   http.Header
	ctx      context.Context
	started  bool
	failed   bool
}

func (writer *sourceControlWriter) Header() http.Header { return writer.header }
func (writer *sourceControlWriter) WriteHeader(status int) {
	if writer.started {
		return
	}
	writer.started = true
	writer.failed = writer.control.Write(protocol.Message{Type: "http-response", StreamID: writer.streamID, Status: status, Headers: protocol.FlattenHeaders(writer.header)}) != nil
}
func (writer *sourceControlWriter) Flush() {
	if !writer.started {
		writer.WriteHeader(http.StatusOK)
	}
}
func (writer *sourceControlWriter) Write(data []byte) (int, error) {
	writer.Flush()
	written := 0
	for len(data) != 0 {
		if writer.failed || writer.ctx.Err() != nil {
			return written, errors.New("Source stream closed")
		}
		size := min(len(data), 32<<10)
		if err := writer.control.Write(protocol.Message{Type: "stream-data", StreamID: writer.streamID, Data: base64.StdEncoding.EncodeToString(data[:size])}); err != nil {
			writer.failed = true
			return written, errors.New("Source stream closed")
		}
		written += size
		data = data[size:]
	}
	return written, nil
}
