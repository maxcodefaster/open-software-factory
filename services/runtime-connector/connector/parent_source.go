package connector

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// Source uses the authenticated Parent socket, never an App port, Child token,
// arbitrary URL, or host listener. Each connection owns its streams; reconnect
// cancels old readers rather than delivering their replies on a new socket.
type parentSourceStreams struct {
	handler http.Handler
	mu      sync.Mutex
	streams map[string]context.CancelFunc
}

// The existing Parent queue serializes Git, but browser work runs alongside it.
// A Source drain must wait for both and then reject every later writer until a
// new cold Parent starts. Keep this fence across control-socket reconnects and
// failed/lost drain replies; neither is authority to resume writing.
type parentSourceFence struct {
	mu           sync.RWMutex
	checkpointID string
}

func (fence *parentSourceFence) wrap(handle func(context.Context, Message) Message) func(context.Context, Message) Message {
	return func(ctx context.Context, message Message) Message {
		denied := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "Source writers are fenced for the recorded checkpoint"}
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

func parentChannels(assignment Assignment) []Channel {
	if assignment.nativeSource == nil {
		return nil
	}
	return []Channel{{Name: "source", Kind: "source"}}
}

func (streams *parentSourceStreams) close(id string) {
	streams.mu.Lock()
	defer streams.mu.Unlock()
	if cancel := streams.streams[id]; cancel != nil {
		cancel()
	}
}

func (streams *parentSourceStreams) start(ctx context.Context, control *controlConnection, message Message) {
	fail := func() {
		_ = control.write(Message{Type: "stream-error", StreamID: message.StreamID, Error: "Source request is unavailable"})
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
			_ = control.write(Message{Type: "stream-end", StreamID: message.StreamID})
		}
	}()
}

type sourceControlWriter struct {
	control  *controlConnection
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
	writer.failed = writer.control.write(Message{Type: "http-response", StreamID: writer.streamID, Status: status, Headers: flattenHeaders(writer.header)}) != nil
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
		if err := writer.control.write(Message{Type: "stream-data", StreamID: writer.streamID, Data: base64.StdEncoding.EncodeToString(data[:size])}); err != nil {
			writer.failed = true
			return written, errors.New("Source stream closed")
		}
		written += size
		data = data[size:]
	}
	return written, nil
}
