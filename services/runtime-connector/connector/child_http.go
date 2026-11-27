package connector

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func (runtime *childRuntime) startHTTPRequest(ctx context.Context, message Message) {
	if message.StreamID == "" {
		return
	}
	channel, declared := runtime.assignment.Channel(message.Channel)
	mutation := declared && channel.Kind == "agent" && message.Method != http.MethodGet && message.Method != http.MethodHead
	ordered := mutation || (declared && channel.Kind == "agent" && isAgentRecoveryRead(message.Method, message.Path))
	var requestContext context.Context
	var cancel context.CancelFunc
	if ordered {
		// Bound observation, not model execution. A mutation timeout before
		// headers is unknown admission and blocks later ordered requests.
		requestContext, cancel = context.WithTimeout(ctx, orderedRequestTimeout)
	} else {
		requestContext, cancel = context.WithCancel(ctx)
	}
	runtime.streamLock.Lock()
	if runtime.httpCancels == nil {
		runtime.httpCancels = make(map[string]context.CancelFunc)
	}
	if _, exists := runtime.httpCancels[message.StreamID]; exists {
		runtime.streamLock.Unlock()
		cancel()
		runtime.sendError(message.StreamID, "stream already exists")
		return
	}
	runtime.httpCancels[message.StreamID] = cancel
	if mutation {
		if runtime.agentMutations == nil {
			runtime.agentMutations = make(map[string]bool)
		}
		runtime.agentMutations[message.StreamID] = true
	}
	runtime.streamLock.Unlock()
	execute := func() {
		defer func() {
			cancel()
			runtime.unregisterHTTPStream(message.StreamID)
		}()
		if ordered && runtime.agentUncertain {
			runtime.sendError(message.StreamID, "Agent request outcome is uncertain; runtime recovery is required")
			return
		}
		uncertain := runtime.handleHTTPRequest(requestContext, message)
		if mutation && uncertain {
			runtime.agentUncertain = true
		}
	}
	if !ordered {
		go execute()
		return
	}
	// Enqueue synchronously in control-frame order. A Stop must not overtake
	// the durable admission of a previously forwarded OpenCode prompt.
	select {
	case runtime.agentRequests <- execute:
	default:
		cancel()
		runtime.unregisterHTTPStream(message.StreamID)
		runtime.sendError(message.StreamID, "Agent request queue is full")
	}
}

func (runtime *childRuntime) unregisterHTTPStream(streamID string) {
	runtime.streamLock.Lock()
	delete(runtime.httpCancels, streamID)
	delete(runtime.agentMutations, streamID)
	runtime.streamLock.Unlock()
}

func (runtime *childRuntime) forwardAgentRequests(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case execute := <-runtime.agentRequests:
			execute()
		}
	}
}

// Native Inbox, retained-message and session reads establish recovery/Stop
// facts. They must observe prior mutations; live log subscriptions must not
// hold the admission queue for their lifetime.
func isAgentRecoveryRead(method, rawPath string) bool {
	if method != http.MethodGet {
		return false
	}
	path, err := url.ParseRequestURI(rawPath)
	if err != nil {
		return false
	}
	return (strings.HasPrefix(path.Path, "/api/session/") || path.Path == "/api/session") &&
		!strings.HasSuffix(path.Path, "/log")
}

// Only loss before response headers leaves upstream admission unknown. All
// pinned OpenCode mutation handlers complete their durable operation before
// responding. Stream delivery failure does not undo that admission.
func (runtime *childRuntime) handleHTTPRequest(ctx context.Context, message Message) bool {
	if message.StreamID == "" {
		return false
	}
	channel, ok := runtime.assignment.Channel(message.Channel)
	if !ok {
		runtime.sendError(message.StreamID, "unknown channel")
		return false
	}
	if message.AppAuthorization != "" && (channel.Kind != "app" || !validAppAuthorization(message.AppAuthorization)) {
		runtime.sendError(message.StreamID, "invalid App authorization")
		return false
	}
	requestURL, err := channelURL(channel, message.Path, false)
	if err != nil {
		runtime.sendError(message.StreamID, err.Error())
		return false
	}
	body, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(body) > maxMessageBytes {
		runtime.sendError(message.StreamID, "invalid request body")
		return false
	}
	request, err := http.NewRequestWithContext(ctx, message.Method, requestURL, bytes.NewReader(body))
	if err != nil {
		runtime.sendError(message.StreamID, "invalid request")
		return false
	}
	copyRequestHeaders(request.Header, message.Headers)
	if channel.Kind == "app" {
		host, err := applyAppRequestHeaders(channel, message, request.Header)
		if err != nil {
			runtime.sendError(message.StreamID, err.Error())
			return false
		}
		if host != "" {
			request.Host = host
		}
	}
	authorizeAgentRequest(request, channel, runtime.assignment)
	if channel.Kind == "ide" && validTheiaConnectionToken(message.TheiaConnectionToken) {
		request.AddCookie(&http.Cookie{Name: "theia-connection-token", Value: message.TheiaConnectionToken})
	}
	response, err := runtime.httpClient.Do(request)
	if err != nil {
		runtime.sendError(message.StreamID, "channel request failed")
		return true
	}
	defer response.Body.Close()
	cookies := response.Header.Values("Set-Cookie")
	if !validResponseCookies(cookies) {
		runtime.sendError(message.StreamID, "invalid channel response cookies")
		return false
	}
	headers := flattenHeaders(response.Header)
	delete(headers, "Set-Cookie")
	if err := runtime.send(Message{
		Type:     "http-response",
		StreamID: message.StreamID,
		Status:   response.StatusCode,
		Headers:  headers,
		Cookies:  cookies,
	}); err != nil {
		return false
	}
	// Native subscriptions have no lifetime byte limit. Each frame is still
	// bounded and synchronously forwarded; Factory cancels slow readers at its
	// bounded receive buffer. Ordinary responses retain their total byte limit.
	nativeStream := isNativeAgentEventStream(channel, message.Method, request, response)
	var reader io.Reader = response.Body
	if !nativeStream {
		reader = io.LimitReader(response.Body, maxResponseBytes+1)
	}
	buffer := make([]byte, 32<<10)
	total := 0
	for {
		count, readErr := reader.Read(buffer)
		if count > 0 {
			if !nativeStream {
				total += count
				if total > maxResponseBytes {
					runtime.sendError(message.StreamID, "channel response exceeded limit")
					return false
				}
			}
			if err := runtime.send(Message{
				Type:     "stream-data",
				StreamID: message.StreamID,
				Data:     base64.StdEncoding.EncodeToString(buffer[:count]),
			}); err != nil {
				return false
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			runtime.sendError(message.StreamID, "read channel response")
			return false
		}
	}
	_ = runtime.send(Message{Type: "stream-end", StreamID: message.StreamID})
	return false
}

func isNativeAgentEventStream(channel Channel, method string, request *http.Request, response *http.Response) bool {
	if channel.Kind != "agent" || method != http.MethodGet || response.StatusCode != http.StatusOK {
		return false
	}
	mediaType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if !strings.EqualFold(mediaType, "text/event-stream") {
		return false
	}
	if request.URL.Path == "/api/event" {
		return true
	}
	parts := strings.Split(request.URL.Path, "/")
	return len(parts) == 5 && parts[1] == "api" && parts[2] == "session" &&
		parts[3] != "" && parts[4] == "log" && request.URL.Query().Get("follow") == "true"
}
