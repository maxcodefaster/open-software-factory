package connector

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type childRuntime struct {
	assignment     Assignment
	control        *controlConnection
	httpClient     *http.Client
	streams        map[string]*websocket.Conn
	httpCancels    map[string]context.CancelFunc
	agentMutations map[string]bool
	agentRequests  chan func()
	agentUncertain bool
	streamLock     sync.Mutex
	controlLock    sync.RWMutex
	processes      *processManager
	terminals      *terminalManager
	languages      *languageManager
}

type terminalControl struct {
	Type    string `json:"type"`
	Columns uint16 `json:"columns"`
	Rows    uint16 `json:"rows"`
}

func RunChild(ctx context.Context, assignment Assignment, token string) error {
	return runChild(ctx, assignment, token, nil)
}

func runChild(ctx context.Context, assignment Assignment, token string, prepared *processManager) error {
	ctx, cancelChild := context.WithCancel(ctx)
	defer cancelChild()
	if token == "" {
		return errors.New("Factory connector token is required")
	}
	resetStartupTimings()
	control, err := dialControl(ctx, assignment, "child", token)
	for err != nil {
		// Injection can finish while Factory is restarting. The admitted child
		// must survive first-connect downtime just as it survives later disconnects.
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
		control, err = dialControl(ctx, assignment, "child", token)
	}
	fail := func(err error) error {
		control.write(Message{Type: "status", Phase: "failed", Error: err.Error()})
		control.close()
		return err
	}
	output := io.Writer(os.Stdout)
	if assignment.EnvironmentVersion != nil {
		output = io.Discard
	}
	processes := prepared
	if processes == nil {
		processes = newProcessManager(ctx, assignment, output)
	}
	defer processes.stopAll()
	if !processes.development {
		// Development announces its independent Terminal immediately below.
		// Non-development Apps can take time to become healthy; publish their
		// real process state and output without claiming channel readiness.
		processes.connect(control)
		defer processes.connect(nil)
	}
	if prepared == nil {
		finishProcesses := startupPhase("process-start")
		processErr := processes.startAll()
		finishProcesses()
		if processErr != nil {
			return fail(processErr)
		}
	}
	finishReadiness := startupPhase("channel-readiness")
	readinessErr := waitForChannels(ctx, assignment, processes)
	finishReadiness()
	if readinessErr != nil {
		return fail(readinessErr)
	}
	runtime := &childRuntime{
		assignment: assignment,
		httpClient: &http.Client{
			Transport: &http.Transport{ResponseHeaderTimeout: 60 * time.Second},
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		streams:       make(map[string]*websocket.Conn),
		processes:     processes,
		agentRequests: make(chan func(), 16),
	}
	agentDone := make(chan struct{})
	go func() {
		defer close(agentDone)
		runtime.forwardAgentRequests(ctx)
	}()
	defer func() {
		cancelChild()
		runtime.setControl(nil)
		control.close()
		<-agentDone
	}()
	runtime.terminals = newTerminalManager(ctx, assignment, runtime.send)
	go runtime.terminals.watch()
	defer runtime.terminals.closeAll()
	runtime.languages = newLanguageManager(ctx, assignment, runtime.send)
	defer runtime.languages.closeAll()
	for {
		runtime.languages.reconnect()
		runtime.setControl(control)
		terminals := runtime.terminals.observation()
		if err := control.write(Message{
			Type:             "hello",
			Role:             "child",
			AttemptID:        assignment.RuntimeAttemptID,
			Generation:       assignment.Generation,
			Channels:         assignment.Channels,
			TerminalCount:    terminals.TerminalCount,
			TerminalBusy:     terminals.TerminalBusy,
			TerminalRevision: terminals.TerminalRevision,
		}); err != nil {
			control.close()
		} else {
			processes.connect(control)
			readErrors := make(chan error, 1)
			go func() { readErrors <- runtime.readLoop(ctx, control) }()
			select {
			case <-ctx.Done():
				processes.connect(nil)
				runtime.setControl(nil)
				control.close()
				return nil
			case err := <-processes.fatal:
				processes.connect(nil)
				runtime.setControl(nil)
				return fail(err)
			case <-readErrors:
				processes.connect(nil)
				runtime.setControl(nil)
				runtime.disconnectStreams()
				control.close()
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case err := <-processes.fatal:
			return err
		case <-time.After(250 * time.Millisecond):
		}
		for {
			control, err = dialControl(ctx, assignment, "child", token)
			if err == nil {
				break
			}
			select {
			case <-ctx.Done():
				return nil
			case processErr := <-processes.fatal:
				return processErr
			case <-time.After(time.Second):
			}
		}
	}
}

func waitForChannels(ctx context.Context, assignment Assignment, processes *processManager) error {
	client := http.Client{Timeout: 2 * time.Second}
	for _, channel := range assignment.Channels {
		if channel.Kind == "ide" {
			// This child owns real PTYs. No editor lives in execution, and App
			// or Agent health must not gate its authenticated connection.
			return nil
		}
	}
	for _, channel := range assignment.Channels {
		healthURL := strings.TrimSuffix(channel.Target, "/") + channel.HealthPath
		ready := false
		lastFailure := "health endpoint has not responded"
		readinessFailure := func(cause error) error {
			detail := lastFailure
			if processes != nil {
				if output := processes.startupDiagnostic(channel.Name, assignment); output != "" {
					detail += "; " + output
				}
			}
			if cause != nil {
				return fmt.Errorf("channel %q did not become ready: %s: %w", channel.Name, detail, cause)
			}
			return fmt.Errorf("channel %q did not become ready: %s", channel.Name, detail)
		}
		for attempt := 0; attempt < 120; attempt++ {
			if processes != nil {
				if err := processes.startupFailure(assignment); err != nil {
					return err
				}
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
			if err != nil {
				return fmt.Errorf("create health request for channel %q: %w", channel.Name, err)
			}
			authorizeAgentRequest(request, channel, assignment)
			response, err := client.Do(request)
			if err == nil {
				io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
				response.Body.Close()
				if response.StatusCode >= 200 && response.StatusCode < 400 {
					ready = true
					break
				}
				lastFailure = fmt.Sprintf("last health response was HTTP %d", response.StatusCode)
			} else {
				// Do not retain response bodies or a URL-bearing transport error.
				// Either may contain Project credentials.
				lastFailure = "health connection failed"
			}
			select {
			case <-ctx.Done():
				return readinessFailure(ctx.Err())
			case <-time.After(250 * time.Millisecond):
			}
		}
		if !ready {
			return readinessFailure(nil)
		}
	}
	return nil
}

func (runtime *childRuntime) readLoop(ctx context.Context, control *controlConnection) error {
	for {
		var message Message
		if err := control.connection.ReadJSON(&message); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("read Factory control message: %w", err)
		}
		switch message.Type {
		case "http-request":
			runtime.startHTTPRequest(ctx, message)
		case "websocket-open":
			if message.Channel == "language" {
				runtime.languages.attach(message)
			} else {
				go runtime.openWebSocket(ctx, message)
			}
		case "websocket-message":
			runtime.writeWebSocket(message)
		case "stream-close":
			runtime.closeStream(message.StreamID)
		case "operation-request":
			go runtime.handleOperation(message)
		default:
			if err := runtime.send(Message{Type: "stream-error", StreamID: message.StreamID, Error: "unsupported message"}); err != nil {
				return err
			}
		}
	}
}

func (runtime *childRuntime) setControl(control *controlConnection) {
	runtime.controlLock.Lock()
	runtime.control = control
	runtime.controlLock.Unlock()
}

func (runtime *childRuntime) send(message Message) error {
	runtime.controlLock.RLock()
	control := runtime.control
	runtime.controlLock.RUnlock()
	if control == nil {
		return errors.New("Factory control connection is unavailable")
	}
	return control.write(message)
}

func (runtime *childRuntime) handleOperation(message Message) {
	response := Message{
		Type:        "operation-response",
		OperationID: message.OperationID,
		Action:      message.Action,
		Process:     message.Process,
		TerminalID:  message.TerminalID,
	}
	if message.OperationID == "" {
		response.Error = "operation identity is required"
	} else if strings.HasPrefix(message.Action, "process-") {
		response.Error = errorText(runtime.processes.action(message.Process, message.Action))
	} else if message.Action == "terminal-close" {
		response.Error = errorText(runtime.terminals.close(message.TerminalID))
	} else {
		response.Error = "unsupported child operation"
	}
	_ = runtime.send(response)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (runtime *childRuntime) startHTTPRequest(ctx context.Context, message Message) {
	if message.StreamID == "" {
		return
	}
	requestContext, cancel := context.WithCancel(ctx)
	channel, declared := runtime.assignment.channel(message.Channel)
	path, pathError := url.ParseRequestURI(message.Path)
	// Native Inbox, retained-message and session reads establish recovery/Stop
	// facts. They must observe prior mutations; live log subscriptions must not
	// hold the admission queue for their lifetime.
	recoveryRead := message.Method == http.MethodGet && pathError == nil &&
		(strings.HasPrefix(path.Path, "/api/session/") || path.Path == "/api/session") &&
		!strings.HasSuffix(path.Path, "/log")
	mutation := declared && channel.Kind == "agent" && message.Method != http.MethodGet && message.Method != http.MethodHead
	ordered := mutation || (declared && channel.Kind == "agent" && recoveryRead)
	if ordered {
		cancel()
		// Bound observation, not model execution. A mutation timeout before
		// headers is unknown admission and blocks later ordered requests.
		requestContext, cancel = context.WithTimeout(ctx, 60*time.Second)
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
			runtime.streamLock.Lock()
			delete(runtime.httpCancels, message.StreamID)
			delete(runtime.agentMutations, message.StreamID)
			runtime.streamLock.Unlock()
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
		runtime.streamLock.Lock()
		delete(runtime.httpCancels, message.StreamID)
		delete(runtime.agentMutations, message.StreamID)
		runtime.streamLock.Unlock()
		runtime.sendError(message.StreamID, "Agent request queue is full")
	}
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

// Only loss before response headers leaves upstream admission unknown. All
// pinned OpenCode mutation handlers complete their durable operation before
// responding. Stream delivery failure does not undo that admission.
func (runtime *childRuntime) handleHTTPRequest(ctx context.Context, message Message) bool {
	if message.StreamID == "" {
		return false
	}
	channel, ok := runtime.assignment.channel(message.Channel)
	if !ok {
		runtime.sendError(message.StreamID, "unknown channel")
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
		// Factory has authenticated this App request and removed all Factory
		// credentials. App cookies remain scoped to their runtime path/origin.
		if cookie := message.Headers["cookie"]; cookie != "" {
			request.Header.Set("Cookie", cookie)
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
	if err := runtime.send(Message{
		Type:     "http-response",
		StreamID: message.StreamID,
		Status:   response.StatusCode,
		Headers:  flattenHeaders(response.Header),
	}); err != nil {
		return false
	}
	// Native subscriptions have no lifetime byte limit. Each frame is still
	// bounded and synchronously forwarded; Factory cancels slow readers at its
	// bounded receive buffer. Ordinary responses retain their total byte limit.
	parts := strings.Split(request.URL.Path, "/")
	followingLog := len(parts) == 5 && parts[1] == "api" && parts[2] == "session" &&
		parts[3] != "" && parts[4] == "log" && request.URL.Query().Get("follow") == "true"
	nativeStream := channel.Kind == "agent" && message.Method == http.MethodGet &&
		response.StatusCode == http.StatusOK &&
		strings.EqualFold(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]), "text/event-stream") &&
		(request.URL.Path == "/api/event" || followingLog)
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

// Only the declared Agent loopback channel receives the assignment's generation capability.
// Browser and App headers can neither choose nor override OpenCode server credentials.
func authorizeAgentRequest(request *http.Request, channel Channel, assignment Assignment) {
	if channel.Kind != "agent" {
		return
	}
	for _, process := range assignment.Processes {
		if process.Name != channel.Name {
			continue
		}
		if password := process.Env["OPENCODE_PASSWORD"]; password != "" {
			request.SetBasicAuth("opencode", password)
		}
		return
	}
}

func (runtime *childRuntime) openWebSocket(ctx context.Context, message Message) {
	if message.StreamID == "" {
		return
	}
	if message.Channel == "terminal" {
		runtime.terminals.attach(message)
		return
	}
	channel, ok := runtime.assignment.channel(message.Channel)
	if !ok {
		runtime.sendError(message.StreamID, "unknown channel")
		return
	}
	target, err := channelURL(channel, message.Path, true)
	if err != nil {
		runtime.sendError(message.StreamID, err.Error())
		return
	}
	headers := http.Header{}
	for name, value := range message.Headers {
		if allowedRequestHeader(name) {
			headers.Set(name, value)
		}
	}
	if channel.Kind == "app" {
		if cookie := message.Headers["cookie"]; cookie != "" {
			headers.Set("Cookie", cookie)
		}
	}
	if channel.Kind == "ide" && validTheiaConnectionToken(message.TheiaConnectionToken) {
		headers.Add("Cookie", "theia-connection-token="+message.TheiaConnectionToken)
	}
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	if message.Protocol != "" {
		dialer.Subprotocols = []string{message.Protocol}
	}
	connection, response, err := dialer.DialContext(ctx, target, headers)
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err != nil {
		runtime.sendError(message.StreamID, "channel WebSocket failed")
		return
	}
	connection.SetReadLimit(maxMessageBytes)
	runtime.streamLock.Lock()
	if _, exists := runtime.streams[message.StreamID]; exists {
		runtime.streamLock.Unlock()
		connection.Close()
		runtime.sendError(message.StreamID, "stream already exists")
		return
	}
	runtime.streams[message.StreamID] = connection
	runtime.streamLock.Unlock()
	if err := runtime.send(Message{Type: "websocket-ready", StreamID: message.StreamID, Protocol: connection.Subprotocol()}); err != nil {
		runtime.closeStream(message.StreamID)
		return
	}
	for {
		messageType, data, err := connection.ReadMessage()
		if err != nil {
			break
		}
		if len(data) > maxMessageBytes {
			break
		}
		if err := runtime.send(Message{
			Type:        "websocket-message",
			StreamID:    message.StreamID,
			MessageType: messageType,
			Data:        base64.StdEncoding.EncodeToString(data),
		}); err != nil {
			break
		}
	}
	runtime.closeStream(message.StreamID)
	_ = runtime.send(Message{Type: "stream-close", StreamID: message.StreamID})
}

func (runtime *childRuntime) writeWebSocket(message Message) {
	if runtime.languages != nil {
		if language, err := runtime.languages.write(message); language {
			if err != nil {
				runtime.sendError(message.StreamID, err.Error())
				runtime.languages.close(message.StreamID)
			}
			return
		}
	}
	if terminal, err := runtime.terminals.write(message); terminal {
		if err != nil {
			runtime.sendError(message.StreamID, err.Error())
		}
		return
	}
	data, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil || len(data) > maxMessageBytes || (message.MessageType != websocket.TextMessage && message.MessageType != websocket.BinaryMessage) {
		runtime.sendError(message.StreamID, "invalid WebSocket message")
		return
	}
	runtime.streamLock.Lock()
	connection := runtime.streams[message.StreamID]
	runtime.streamLock.Unlock()
	if connection == nil {
		runtime.sendError(message.StreamID, "unknown stream")
		return
	}
	if err := connection.WriteMessage(message.MessageType, data); err != nil {
		runtime.closeStream(message.StreamID)
	}
}

func (runtime *childRuntime) closeStream(streamID string) {
	if runtime.languages != nil && runtime.languages.close(streamID) {
		return
	}
	if runtime.terminals != nil && runtime.terminals.detach(streamID) {
		return
	}
	runtime.streamLock.Lock()
	connection := runtime.streams[streamID]
	cancel := runtime.httpCancels[streamID]
	if runtime.agentMutations[streamID] {
		// OpenCode admission is uninterruptible. Keep observing its response
		// even after the Factory HTTP consumer detaches, or Stop could pass it.
		// Ordered reads have no external effect and must release this queue
		// when their consumer times out or disconnects.
		cancel = nil
	}
	delete(runtime.streams, streamID)
	runtime.streamLock.Unlock()
	if cancel != nil {
		cancel()
	}
	if connection != nil {
		connection.Close()
	}
}

func (runtime *childRuntime) disconnectStreams() {
	runtime.streamLock.Lock()
	streams := runtime.streams
	cancels := make([]context.CancelFunc, 0, len(runtime.httpCancels))
	for streamID, cancel := range runtime.httpCancels {
		if !runtime.agentMutations[streamID] {
			cancels = append(cancels, cancel)
		}
	}
	runtime.streams = make(map[string]*websocket.Conn)
	runtime.streamLock.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	for _, connection := range streams {
		connection.Close()
	}
	runtime.terminals.detachAll()
	if runtime.languages != nil {
		runtime.languages.closeAll()
	}
}

func (runtime *childRuntime) sendError(streamID string, message string) {
	_ = runtime.send(Message{Type: "stream-error", StreamID: streamID, Error: message})
}

func channelURL(channel Channel, path string, websocketTarget bool) (string, error) {
	if channel.Kind == "ide" || validateTarget(channel.Target) != nil {
		return "", errors.New("channel has no HTTP endpoint")
	}
	if path == "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return "", errors.New("invalid channel path")
	}
	reference, err := url.Parse(path)
	if err != nil || reference.IsAbs() || reference.Host != "" {
		return "", errors.New("invalid channel path")
	}
	base, _ := url.Parse(channel.Target)
	base.Path = reference.Path
	base.RawPath = reference.RawPath
	base.RawQuery = reference.RawQuery
	if websocketTarget {
		base.Scheme = "ws"
	}
	return base.String(), nil
}

func copyRequestHeaders(destination http.Header, source map[string]string) {
	for name, value := range source {
		if allowedRequestHeader(name) {
			destination.Set(name, value)
		}
	}
}

func allowedRequestHeader(name string) bool {
	switch strings.ToLower(name) {
	case "authorization", "cookie", "connection", "host", "proxy-authorization", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "upgrade":
		return false
	default:
		return true
	}
}

func validTheiaConnectionToken(token string) bool {
	if token == "" || len(token) > 256 {
		return false
	}
	for _, character := range token {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '_' || character == '~' || character == '-' {
			continue
		}
		return false
	}
	return true
}
