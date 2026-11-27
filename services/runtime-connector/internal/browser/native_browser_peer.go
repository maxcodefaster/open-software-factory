package browser

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

type nativeBrowserFrame struct {
	Type        string                    `json:"type"`
	ActorUID    string                    `json:"actorUID,omitempty"`
	SessionID   string                    `json:"sessionID,omitempty"`
	ID          string                    `json:"id,omitempty"`
	Operation   *protocol.Message         `json:"operation,omitempty"`
	Scope       *browserRuntimeRequest    `json:"scope,omitempty"`
	App         string                    `json:"app,omitempty"`
	Method      string                    `json:"method,omitempty"`
	Path        string                    `json:"path,omitempty"`
	Headers     http.Header               `json:"headers,omitempty"`
	Status      int                       `json:"status,omitempty"`
	Data        string                    `json:"data,omitempty"`
	MessageType int                       `json:"messageType,omitempty"`
	Protocol    string                    `json:"protocol,omitempty"`
	Error       string                    `json:"error,omitempty"`
	Context     *browserInspectionContext `json:"context,omitempty"`
}

type nativeBrowserPending struct {
	first  chan nativeBrowserFrame
	data   chan []byte
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
	err    error
	bytes  int
	head   bool
	kind   string
	socket chan nativeBrowserFrame
}

func (pending *nativeBrowserPending) end(err error) {
	pending.once.Do(func() {
		pending.mu.Lock()
		pending.err = err
		pending.mu.Unlock()
		close(pending.done)
	})
}

type nativeBrowserPeer struct {
	connection *websocket.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	write      sync.Mutex
	mu         sync.Mutex
	pending    map[string]*nativeBrowserPending
	scope      browserRuntimeRequest
	routes     map[string]string
}

func newNativeBrowserPeer(ctx context.Context, connection *websocket.Conn, scope browserRuntimeRequest, channels []protocol.Channel) (*nativeBrowserPeer, error) {
	live, cancel := context.WithCancel(ctx)
	peer := &nativeBrowserPeer{connection: connection, ctx: live, cancel: cancel,
		scope: scope, pending: make(map[string]*nativeBrowserPending), routes: make(map[string]string)}
	for _, channel := range channels {
		if channel.Kind != "app" || protocol.ValidateTarget(channel.Target) != nil {
			cancel()
			return nil, errors.New("native Browser relay requires declared Apps")
		}
		target, _ := url.Parse(channel.Target)
		destination := &url.URL{Scheme: "http", Host: "127.0.0.1:" + target.Port()}
		key := browserOrigin(destination)
		if peer.routes[key] != "" {
			cancel()
			return nil, errors.New("native Browser App destinations must be unique")
		}
		peer.routes[key] = channel.Name
	}
	return peer, nil
}

func (peer *nativeBrowserPeer) send(frame nativeBrowserFrame) error {
	return peer.sendContext(peer.ctx, frame)
}

func (peer *nativeBrowserPeer) sendContext(ctx context.Context, frame nativeBrowserFrame) error {
	data, err := json.Marshal(frame)
	if err != nil || len(data) > nativeBrowserMaxFrame {
		return errors.New("native Browser frame exceeds its bound")
	}
	peer.write.Lock()
	defer peer.write.Unlock()
	if peer.ctx.Err() != nil || ctx.Err() != nil {
		return errors.New("native Browser control connection ended")
	}
	if peer.connection.SetWriteDeadline(time.Now().Add(10*time.Second)) != nil ||
		peer.connection.WriteMessage(websocket.TextMessage, data) != nil {
		peer.cancel()
		return errors.New("native Browser response was not confirmed")
	}
	return nil
}

func (peer *nativeBrowserPeer) request(ctx context.Context, frame nativeBrowserFrame) (*nativeBrowserPending, func(), error) {
	if ctx.Err() != nil || peer.ctx.Err() != nil {
		return nil, nil, errors.New("native Browser relay authority ended")
	}
	id, err := nativeBrowserMessageID()
	if err != nil {
		return nil, nil, err
	}
	pending := &nativeBrowserPending{first: make(chan nativeBrowserFrame, 1),
		data: make(chan []byte, 16), done: make(chan struct{}), kind: frame.Type,
		socket: make(chan nativeBrowserFrame, 16)}
	peer.mu.Lock()
	if len(peer.pending) >= 32 {
		peer.mu.Unlock()
		return nil, nil, errors.New("native Browser relay is busy")
	}
	peer.pending[id] = pending
	peer.mu.Unlock()
	frame.ID, frame.Scope = id, &peer.scope
	release := func() {
		peer.mu.Lock()
		current := peer.pending[id] == pending
		delete(peer.pending, id)
		peer.mu.Unlock()
		pending.end(context.Canceled)
		if current && peer.ctx.Err() == nil {
			_ = peer.send(nativeBrowserFrame{Type: "relay-cancel", ID: id})
		}
	}
	if err := peer.sendContext(ctx, frame); err != nil {
		release()
		return nil, nil, err
	}
	return pending, release, nil
}

func (peer *nativeBrowserPeer) receive(frame nativeBrowserFrame) error {
	peer.mu.Lock()
	pending := peer.pending[frame.ID]
	peer.mu.Unlock()
	if pending == nil {
		return nil
	}
	switch frame.Type {
	case "app-head", "inspection-context", "app-socket-ready":
		if pending.head {
			return errors.New("native Browser relay response was repeated")
		}
		pending.head = true
		select {
		case pending.first <- frame:
		default:
			return errors.New("native Browser relay response was repeated")
		}
	case "app-data":
		if !pending.head || pending.kind != "app-request" {
			return errors.New("native Browser App data arrived before response headers")
		}
		data, err := base64.StdEncoding.DecodeString(frame.Data)
		if err != nil || len(data) == 0 || len(data) > 64<<10 {
			return errors.New("native Browser App response frame is invalid")
		}
		pending.bytes += len(data)
		if pending.bytes > protocol.MaxResponseBytes {
			pending.end(errors.New("native Browser App response exceeds its bound"))
			return nil
		}
		select {
		case pending.data <- data:
		case <-pending.done:
		default:
			pending.end(errors.New("native Browser App response consumer is too slow"))
		}
	case "app-end":
		if pending.kind != "app-request" {
			return errors.New("native Browser relay response kind changed")
		}
		pending.end(nil)
	case "app-socket-message":
		data, err := base64.StdEncoding.Strict().DecodeString(frame.Data)
		if pending.kind != "app-socket-open" || !pending.head || err != nil ||
			len(data) > 64<<10 || (frame.MessageType != websocket.TextMessage && frame.MessageType != websocket.BinaryMessage) {
			return errors.New("native Browser App WebSocket frame is invalid")
		}
		pending.bytes += len(data)
		if pending.bytes > protocol.MaxResponseBytes {
			pending.end(errors.New("native Browser App WebSocket output exceeds its bound"))
			return nil
		}
		select {
		case pending.socket <- nativeBrowserFrame{MessageType: frame.MessageType, Data: frame.Data}:
		case <-pending.done:
		default:
			pending.end(errors.New("native Browser App WebSocket consumer is too slow"))
		}
	case "app-socket-close":
		if pending.kind != "app-socket-open" {
			return errors.New("native Browser relay response kind changed")
		}
		pending.end(nil)
	case "relay-error":
		// Never copy an App's or infrastructure peer's diagnostic verbatim.
		pending.end(errors.New("native Browser relay operation was not confirmed"))
	default:
		return errors.New("unsupported native Browser relay response")
	}
	return nil
}

func (peer *nativeBrowserPeer) observation(ctx context.Context, scope browserRuntimeRequest, app string) (*browserInspectionContext, error) {
	if !sameBrowserScope(scope, peer.scope) {
		return nil, errors.New("native Browser observation has another owner")
	}
	pending, release, err := peer.request(ctx, nativeBrowserFrame{Type: "inspection-request", App: app})
	if err != nil {
		return nil, err
	}
	defer release()
	var result nativeBrowserFrame
	select {
	case result = <-pending.first:
	case <-ctx.Done():
	case <-peer.ctx.Done():
	case <-pending.done:
	}
	// A buffered reply and cancellation can both be ready. Selecting the reply
	// does not restore ended request or connection authority.
	if ctx.Err() != nil || peer.ctx.Err() != nil || result.Type != "inspection-context" || result.Context == nil {
		return nil, errors.New("native Browser Source context is unavailable")
	}
	return result.Context, nil
}

func validNativeBrowserHeaders(headers http.Header) bool {
	size := 0
	for name, values := range headers {
		if name == "" || strings.ContainsAny(name, "()<>@,;:\\\"/[]?={} \t\r\n\x00") || len(values) > 64 {
			return false
		}
		for index := range len(name) {
			if name[index] < 33 || name[index] > 126 {
				return false
			}
		}
		size += len(name)
		for _, value := range values {
			for index := range len(value) {
				if value[index] < ' ' && value[index] != '\t' || value[index] == 127 {
					return false
				}
			}
			size += len(value)
		}
	}
	return len(headers) <= 128 && size <= 64<<10
}

func (peer *nativeBrowserPeer) RoundTrip(request *http.Request) (*http.Response, error) {
	app := peer.routes[browserOrigin(request.URL)]
	if app == "" || request.URL.Scheme != "http" || request.URL.User != nil ||
		!validNativeBrowserHeaders(request.Header) || request.Method == http.MethodConnect ||
		(request.Header.Get("Upgrade") != "" && !websocket.IsWebSocketUpgrade(request)) {
		return nil, errors.New("native Browser request is not a supported declared App request")
	}
	if websocket.IsWebSocketUpgrade(request) {
		return peer.openAppSocket(request, app)
	}
	var body []byte
	if request.Body != nil {
		var err error
		body, err = io.ReadAll(io.LimitReader(request.Body, maxBrowserRequestBytes+1))
		request.Body.Close()
		if err != nil || len(body) > maxBrowserRequestBytes {
			return nil, errors.New("native Browser App request exceeds its bound")
		}
	}
	pending, release, err := peer.request(request.Context(), nativeBrowserFrame{
		Type: "app-request", App: app, Method: request.Method, Path: request.URL.RequestURI(),
		Headers: request.Header.Clone(), Data: base64.StdEncoding.EncodeToString(body),
	})
	if err != nil {
		return nil, err
	}
	var first nativeBrowserFrame
	select {
	case first = <-pending.first:
	case <-request.Context().Done():
	case <-peer.ctx.Done():
	case <-pending.done:
		// A fast response can finish before RoundTrip starts waiting. Its
		// already buffered headers still precede that end, including for 204/HEAD.
		select {
		case first = <-pending.first:
		default:
		}
	}
	if request.Context().Err() != nil || peer.ctx.Err() != nil || first.Type == "" {
		release()
		return nil, errors.New("native Browser App response is unavailable")
	}
	if first.Type != "app-head" || first.Status < 200 || first.Status > 599 ||
		!validNativeBrowserHeaders(first.Headers) {
		release()
		return nil, errors.New("native Browser App response is invalid")
	}
	headers := make(http.Header)
	for name, values := range first.Headers {
		for _, value := range values {
			headers.Add(name, value)
		}
	}
	return &http.Response{StatusCode: first.Status, Header: headers, ContentLength: -1,
		Request: request, Body: &nativeBrowserResponseBody{pending: pending, release: release,
			ctx: request.Context(), peer: peer.ctx}}, nil
}

// ReverseProxy's existing upgrade path needs a duplex HTTP response body.
// Gorilla owns framing on a bounded in-memory pipe; no App address is dialled.
type nativeBrowserUpgradeWriter struct {
	connection net.Conn
	header     http.Header
}

func (writer *nativeBrowserUpgradeWriter) Header() http.Header { return writer.header }
func (writer *nativeBrowserUpgradeWriter) WriteHeader(int)     {}
func (writer *nativeBrowserUpgradeWriter) Write([]byte) (int, error) {
	return 0, errors.New("native Browser WebSocket upgrade failed")
}
func (writer *nativeBrowserUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return writer.connection, bufio.NewReadWriter(bufio.NewReader(writer.connection), bufio.NewWriter(writer.connection)), nil
}

func (peer *nativeBrowserPeer) openAppSocket(request *http.Request, app string) (*http.Response, error) {
	protocols := websocket.Subprotocols(request)
	key, err := base64.StdEncoding.DecodeString(request.Header.Get("Sec-WebSocket-Key"))
	if request.Method != http.MethodGet || request.Header.Get("Sec-WebSocket-Version") != "13" ||
		err != nil || len(key) != 16 || request.ContentLength > 0 ||
		len(protocols) > 16 {
		return nil, errors.New("native Browser App WebSocket handshake is invalid")
	}
	// Compression is not negotiated. The existing App channel selects at most
	// one offered protocol; the returned selection is checked again here.
	pending, release, err := peer.request(request.Context(), nativeBrowserFrame{
		Type: "app-socket-open", App: app, Path: request.URL.RequestURI(), Headers: request.Header.Clone(),
	})
	if err != nil {
		return nil, err
	}
	var first nativeBrowserFrame
	select {
	case first = <-pending.first:
	case <-pending.done:
		select {
		case first = <-pending.first:
		default:
		}
	case <-request.Context().Done():
	case <-peer.ctx.Done():
	}
	if request.Context().Err() != nil || peer.ctx.Err() != nil || first.Type != "app-socket-ready" ||
		(first.Protocol != "" && !nativeBrowserOfferedProtocol(protocols, first.Protocol)) {
		release()
		return nil, errors.New("native Browser App WebSocket was not confirmed")
	}
	client, server := net.Pipe()
	stopRequest := context.AfterFunc(request.Context(), func() { client.Close(); server.Close() })
	stopPeer := context.AfterFunc(peer.ctx, func() { client.Close(); server.Close() })
	go func() {
		defer release()
		defer client.Close()
		defer server.Close()
		defer stopRequest()
		defer stopPeer()
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		if first.Protocol != "" {
			upgrader.Subprotocols = []string{first.Protocol}
		}
		connection, err := upgrader.Upgrade(&nativeBrowserUpgradeWriter{server, make(http.Header)}, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		connection.SetReadLimit(64 << 10)
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer connection.Close()
			for {
				var frame nativeBrowserFrame
				select {
				case <-pending.done:
					pending.mu.Lock()
					failed := pending.err != nil
					pending.mu.Unlock()
					if failed {
						return
					}
					// Drain frames that preceded an ordinary upstream close.
					select {
					case frame = <-pending.socket:
					default:
						return
					}
				default:
					select {
					case frame = <-pending.socket:
					case <-pending.done:
						continue
					case <-request.Context().Done():
						return
					case <-peer.ctx.Done():
						return
					}
				}
				if request.Context().Err() != nil || peer.ctx.Err() != nil {
					return
				}
				pending.mu.Lock()
				failed := pending.err != nil
				pending.mu.Unlock()
				if failed {
					return
				}
				data, _ := base64.StdEncoding.DecodeString(frame.Data)
				_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if connection.WriteMessage(frame.MessageType, data) != nil {
					return
				}
			}
		}()
		for {
			kind, data, err := connection.ReadMessage()
			if err != nil || request.Context().Err() != nil || peer.ctx.Err() != nil {
				break
			}
			if err := peer.sendContext(request.Context(), nativeBrowserFrame{Type: "app-socket-message", ID: first.ID,
				Scope: &peer.scope, MessageType: kind, Data: base64.StdEncoding.EncodeToString(data)}); err != nil {
				break
			}
		}
		pending.end(context.Canceled)
		connection.Close()
		<-done
	}()
	response, err := http.ReadResponse(bufio.NewReader(client), request)
	if err != nil {
		client.Close()
		return nil, errors.New("native Browser App WebSocket handshake failed")
	}
	response.Body = client
	// 101 has no HTTP entity. -1 would make ReverseProxy's Response.Write add
	// Connection: close and invalidate the otherwise confirmed upgrade.
	response.ContentLength = 0
	return response, nil
}

func nativeBrowserOfferedProtocol(protocols []string, selected string) bool {
	for _, protocol := range protocols {
		if protocol == selected {
			return true
		}
	}
	return false
}

type nativeBrowserResponseBody struct {
	pending *nativeBrowserPending
	release func()
	ctx     context.Context
	peer    context.Context
	buffer  bytes.Reader
}

func (body *nativeBrowserResponseBody) Read(data []byte) (int, error) {
	for {
		if err := body.ctx.Err(); err != nil {
			return 0, err
		}
		if body.peer.Err() != nil {
			return 0, errors.New("native Browser App stream ended")
		}
		if body.buffer.Len() != 0 {
			return body.buffer.Read(data)
		}
		// Drain all already received frames before observing a normal end.
		select {
		case next := <-body.pending.data:
			body.buffer.Reset(next)
			continue
		default:
		}
		select {
		case next := <-body.pending.data:
			body.buffer.Reset(next)
		case <-body.pending.done:
			body.pending.mu.Lock()
			err := body.pending.err
			body.pending.mu.Unlock()
			if err == nil {
				select {
				case next := <-body.pending.data:
					body.buffer.Reset(next)
					continue
				default:
				}
				err = io.EOF
			}
			return 0, err
		case <-body.ctx.Done():
			return 0, body.ctx.Err()
		case <-body.peer.Done():
			return 0, errors.New("native Browser App stream ended")
		}
	}
}

func nativeBrowserMessageID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", errors.New("native Browser message identity is unavailable")
	}
	value[6], value[8] = value[6]&0x0f|0x40, value[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}

func (body *nativeBrowserResponseBody) Close() error {
	body.release()
	return nil
}

func (peer *nativeBrowserPeer) close() {
	peer.cancel()
	peer.connection.Close()
	peer.mu.Lock()
	defer peer.mu.Unlock()
	for _, pending := range peer.pending {
		pending.end(errors.New("native Browser control connection ended"))
	}
	peer.pending = make(map[string]*nativeBrowserPending)
}
