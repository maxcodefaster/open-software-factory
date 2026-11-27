package connector

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

func (runtime *childRuntime) openWebSocket(ctx context.Context, message Message) {
	if message.StreamID == "" {
		return
	}
	channel, ok := runtime.assignment.Channel(message.Channel)
	// Validate the dedicated App-only credential before dialing or attaching
	// any non-App capability (notably the separately routed terminal).
	if message.AppAuthorization != "" && (!ok || channel.Kind != "app" ||
		message.Channel == "terminal" || message.Channel == "language" ||
		!validAppAuthorization(message.AppAuthorization)) {
		runtime.sendError(message.StreamID, "invalid App authorization")
		return
	}
	if message.Channel == "terminal" {
		runtime.terminals.Attach(message)
		return
	}
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
		lower := strings.ToLower(name)
		if allowedRequestHeader(name) && !strings.HasPrefix(lower, "x-factory-") &&
			!strings.HasPrefix(lower, "ate-") && !strings.HasPrefix(lower, "proxy-") {
			headers.Set(name, value)
		}
	}
	if channel.Kind == "app" {
		host, err := applyAppRequestHeaders(channel, message, headers)
		if err != nil {
			runtime.sendError(message.StreamID, err.Error())
			return
		}
		if host != "" {
			headers.Set("Host", host)
		}
	}
	if channel.Kind == "ide" && validTheiaConnectionToken(message.TheiaConnectionToken) {
		headers.Add("Cookie", "theia-connection-token="+message.TheiaConnectionToken)
	}
	dialer := websocket.Dialer{HandshakeTimeout: controlHandshakeTimeout}
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
		if language, err := runtime.languages.Write(message); language {
			if err != nil {
				runtime.sendError(message.StreamID, err.Error())
				runtime.languages.Close(message.StreamID)
			}
			return
		}
	}
	if terminal, err := runtime.terminals.Write(message); terminal {
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
	if runtime.languages != nil && runtime.languages.Close(streamID) {
		return
	}
	if runtime.terminals != nil && runtime.terminals.Detach(streamID) {
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
	runtime.terminals.DetachAll()
	if runtime.languages != nil {
		runtime.languages.CloseAll()
	}
}
