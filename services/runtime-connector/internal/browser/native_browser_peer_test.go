package browser

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

type nativeBrowserUnitTrip struct {
	response *http.Response
	err      error
}

type nativeBrowserUnitPeer struct {
	peer   *nativeBrowserPeer
	remote *websocket.Conn
	jobs   sync.WaitGroup
}

// Pause after the real socket write, but before send/request can return.
// Responses can then arrive before RoundTrip enters its first-frame select.
type nativeBrowserUnitWriteGate struct {
	net.Conn
	mu   sync.Mutex
	next <-chan struct{}
}

func (gate *nativeBrowserUnitWriteGate) Write(data []byte) (int, error) {
	count, err := gate.Conn.Write(data)
	gate.mu.Lock()
	resume := gate.next
	gate.next = nil
	gate.mu.Unlock()
	if resume != nil {
		<-resume
	}
	return count, err
}

func (gate *nativeBrowserUnitWriteGate) pauseNextWrite(t *testing.T) func() {
	t.Helper()
	release := make(chan struct{})
	gate.mu.Lock()
	gate.next = release
	gate.mu.Unlock()
	var once sync.Once
	resume := func() { once.Do(func() { close(release) }) }
	t.Cleanup(resume)
	return resume
}

func newNativeBrowserUnitPeer(t *testing.T) *nativeBrowserUnitPeer {
	t.Helper()
	return newNativeBrowserUnitPeerWithWriteGate(t, nil)
}

func newNativeBrowserUnitPeerWithWriteGate(t *testing.T, gate *nativeBrowserUnitWriteGate) *nativeBrowserUnitPeer {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	connections := make(chan *websocket.Conn, 1)
	release := make(chan struct{})
	var handlers sync.WaitGroup
	upgrader := websocket.Upgrader{Subprotocols: []string{nativeBrowserProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		connections <- connection
		<-release
	}))
	fixture := &nativeBrowserUnitPeer{}
	t.Cleanup(func() {
		cancel()
		if fixture.peer != nil {
			fixture.peer.close()
		}
		if fixture.remote != nil {
			fixture.remote.Close()
		}
		close(release)
		server.Close()
		handlers.Wait()
		fixture.jobs.Wait()
	})
	dialer := websocket.Dialer{Subprotocols: []string{nativeBrowserProtocol}, HandshakeTimeout: 2 * time.Second}
	if gate != nil {
		dialer.NetDialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			gate.Conn = connection
			return gate, nil
		}
	}
	connection, response, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if response != nil {
		response.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	fixture.remote = <-connections
	bootstrap := nativeBrowserUnitBootstrap()
	fixture.peer, err = newNativeBrowserPeer(ctx, connection, bootstrap.Scope, bootstrap.Apps)
	if err != nil {
		connection.Close()
		t.Fatal(err)
	}
	return fixture
}

func (fixture *nativeBrowserUnitPeer) roundTrip(request *http.Request) <-chan nativeBrowserUnitTrip {
	result := make(chan nativeBrowserUnitTrip, 1)
	fixture.jobs.Add(1)
	go func() {
		defer fixture.jobs.Done()
		response, err := fixture.peer.RoundTrip(request)
		result <- nativeBrowserUnitTrip{response: response, err: err}
	}()
	return result
}

func (fixture *nativeBrowserUnitPeer) frame(t *testing.T) nativeBrowserFrame {
	t.Helper()
	_ = fixture.remote.SetReadDeadline(time.Now().Add(2 * time.Second))
	var frame nativeBrowserFrame
	if err := fixture.remote.ReadJSON(&frame); err != nil {
		t.Fatal("outgoing native Browser frame unavailable", err)
	}
	return frame
}

func (fixture *nativeBrowserUnitPeer) receive(t *testing.T, frame nativeBrowserFrame) {
	t.Helper()
	if err := fixture.peer.receive(frame); err != nil {
		t.Fatal(err)
	}
}

func nativeBrowserUnitAwaitTrip(t *testing.T, result <-chan nativeBrowserUnitTrip) nativeBrowserUnitTrip {
	t.Helper()
	select {
	case value := <-result:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("native Browser HTTP operation did not settle")
		return nativeBrowserUnitTrip{}
	}
}

func nativeBrowserUnitHTTPRequest(t *testing.T, method, address string, body io.Reader) *http.Request {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, method, address, body)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func (fixture *nativeBrowserUnitPeer) noPending(t *testing.T) {
	t.Helper()
	fixture.peer.mu.Lock()
	defer fixture.peer.mu.Unlock()
	if len(fixture.peer.pending) != 0 {
		t.Fatal("native Browser operation retained pending state after cancellation/close")
	}
}

func TestNativeBrowserPeerUnitWebSocketLoopbackTextBinaryAndCancellation(t *testing.T) {
	for _, ended := range []string{"request", "control", "authority", "upstream"} {
		t.Run(ended, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			// Use the real native control wire, including its response decoder.
			fixture.jobs.Add(1)
			go func() {
				defer fixture.jobs.Done()
				for {
					var frame nativeBrowserFrame
					if fixture.peer.connection.ReadJSON(&frame) != nil {
						return
					}
					if fixture.peer.receive(frame) != nil {
						fixture.peer.close()
						return
					}
				}
			}()
			opened := make(chan nativeBrowserFrame, 1)
			cancelled := make(chan struct{})
			fixture.jobs.Add(1)
			go func() {
				defer fixture.jobs.Done()
				defer close(cancelled)
				for {
					var frame nativeBrowserFrame
					if fixture.remote.ReadJSON(&frame) != nil {
						return
					}
					if frame.Type == "relay-cancel" {
						return
					}
					switch frame.Type {
					case "app-socket-open":
						opened <- frame
						if fixture.remote.WriteJSON(nativeBrowserFrame{Type: "app-socket-ready", ID: frame.ID, Protocol: "owned-app"}) != nil {
							return
						}
					case "app-socket-message":
						if frame.Scope == nil || !sameBrowserScope(*frame.Scope, fixture.peer.scope) {
							return
						}
						if ended == "upstream" && frame.Data == base64.StdEncoding.EncodeToString([]byte("finish")) {
							_ = fixture.remote.WriteJSON(nativeBrowserFrame{Type: "app-socket-message", ID: frame.ID, MessageType: 1, Data: base64.StdEncoding.EncodeToString([]byte("last frame"))})
							_ = fixture.remote.WriteJSON(nativeBrowserFrame{Type: "app-socket-close", ID: frame.ID})
							return
						}
						// Echo both message kinds, including zero-length payloads.
						if fixture.remote.WriteJSON(frame) != nil {
							return
						}
					default:
						return
					}
				}
			}()
			ctx, cancel := context.WithCancel(fixture.peer.ctx)
			defer cancel()
			proxy, err := newNativeBrowserAppProxy(ctx, nativeBrowserUnitBootstrap().Apps, fixture.peer)
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.URL.Scheme, r.URL.Host = "http", "web.factory.invalid"
				proxy.ServeHTTP(w, r)
			}))
			defer server.Close()
			dialer := websocket.Dialer{Subprotocols: []string{"owned-app"}, EnableCompression: true}
			connection, response, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/hmr?q=original",
				http.Header{"Authorization": {"Bearer isolated-app"}, "Cookie": {"session=app-only"}, "Origin": {"http://web.factory.invalid"}})
			if response != nil {
				defer response.Body.Close()
			}
			if err != nil {
				if response != nil {
					body, _ := io.ReadAll(response.Body)
					t.Fatal("native App upgrade failed", err, response.StatusCode, response.Header, string(body))
				}
				t.Fatal("native App upgrade failed", err)
			}
			defer connection.Close()
			frame := <-opened
			if frame.App != "web" || frame.Path != "/hmr?q=original" ||
				frame.Headers.Get("Authorization") != "Bearer isolated-app" ||
				frame.Headers.Get("Cookie") != "session=app-only" || frame.Scope == nil ||
				!sameBrowserScope(*frame.Scope, fixture.peer.scope) || connection.Subprotocol() != "owned-app" {
				t.Fatal("native App upgrade changed frozen scope, handshake or destination")
			}
			for _, kind := range []int{websocket.TextMessage, websocket.BinaryMessage} {
				for _, payload := range [][]byte{[]byte("original text"), {0, 255, 1}, {}} {
					if kind == websocket.TextMessage && len(payload) > 0 && payload[0] == 0 {
						continue
					}
					if err := connection.WriteMessage(kind, payload); err != nil {
						t.Fatal(err)
					}
					_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
					gotKind, data, err := connection.ReadMessage()
					if err != nil || gotKind != kind || string(data) != string(payload) {
						t.Fatal("native WebSocket frame changed", gotKind, err)
					}
				}
			}
			switch ended {
			case "request":
				connection.Close()
			case "control":
				fixture.peer.close()
			case "authority":
				cancel()
			case "upstream":
				if err := connection.WriteMessage(websocket.TextMessage, []byte("finish")); err != nil {
					t.Fatal(err)
				}
				_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
				kind, data, err := connection.ReadMessage()
				if err != nil || kind != websocket.TextMessage || string(data) != "last frame" {
					t.Fatal("upstream close lost its final queued frame", err)
				}
			}
			if ended != "request" {
				_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
				if _, _, err := connection.ReadMessage(); err == nil {
					t.Fatal("ended authority retained WebSocket")
				}
			}
			select {
			case <-cancelled:
			case <-time.After(2 * time.Second):
				t.Fatal("ended upgrade retained its relay")
			}
		})
	}
}

func TestNativeBrowserPeerUnitWebSocketOutputBounds(t *testing.T) {
	for _, bound := range []string{"frame", "queue", "total", "kind", "before-ready"} {
		t.Run(bound, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			pending, release, err := fixture.peer.request(context.Background(), nativeBrowserFrame{Type: "app-socket-open", App: "web"})
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			request := fixture.frame(t)
			if bound != "before-ready" {
				fixture.receive(t, nativeBrowserFrame{Type: "app-socket-ready", ID: request.ID})
			}
			frame := nativeBrowserFrame{Type: "app-socket-message", ID: request.ID, MessageType: 2, Data: "eA=="}
			count := 1
			switch bound {
			case "frame":
				frame.Data = base64.StdEncoding.EncodeToString(make([]byte, (64<<10)+1))
			case "queue":
				count = 17
			case "total":
				pending.bytes = protocol.MaxResponseBytes
			case "kind":
				frame.MessageType = 3
			}
			for range count {
				err = fixture.peer.receive(frame)
			}
			if bound == "queue" || bound == "total" {
				select {
				case <-pending.done:
				default:
					t.Fatal("unbounded native App WebSocket output")
				}
			} else if err == nil {
				t.Fatal("invalid native App WebSocket output admitted")
			}
		})
	}
}

func TestNativeBrowserPeerUnitStreamsAndDemultiplexesOwnedAppAndInspection(t *testing.T) {
	fixture := newNativeBrowserUnitPeer(t)
	request := nativeBrowserUnitHTTPRequest(t, http.MethodPost, "http://127.0.0.1:3000/forms?q=a%2Fb", strings.NewReader("owned-body"))
	request.Header = http.Header{
		"Authorization": {"Bearer app-only"}, "Cookie": {"session=owned"},
		"X-App": {"first", "second"},
	}
	httpResult := fixture.roundTrip(request)
	app := fixture.frame(t)
	payload, err := base64.StdEncoding.DecodeString(app.Data)
	bootstrap := nativeBrowserUnitBootstrap()
	if err != nil || string(payload) != "owned-body" || app.Type != "app-request" || app.App != "web" ||
		app.Method != "POST" || app.Path != "/forms?q=a%2Fb" || app.Scope == nil ||
		!sameBrowserScope(*app.Scope, bootstrap.Scope) || !app.Scope.ExpiresAt.IsZero() ||
		!reflect.DeepEqual(app.Headers, request.Header) ||
		!protocol.UUIDPattern.MatchString(app.ID) {
		t.Fatal("App relay changed its declared target, scope, headers, body or identity")
	}
	type observationResult struct {
		value *browserInspectionContext
		err   error
	}
	observed := make(chan observationResult, 1)
	fixture.jobs.Add(1)
	go func() {
		defer fixture.jobs.Done()
		value, err := fixture.peer.observation(context.Background(), bootstrap.Scope, "web")
		observed <- observationResult{value, err}
	}()
	inspection := fixture.frame(t)
	if inspection.Type != "inspection-request" || inspection.App != "web" || inspection.ID == app.ID ||
		inspection.Scope == nil || !sameBrowserScope(*inspection.Scope, bootstrap.Scope) {
		t.Fatal("Source inspection did not receive a separate scoped operation identity")
	}
	expectedContext := &browserInspectionContext{
		SessionID: bootstrap.Scope.SessionID, TurnID: bootstrap.Scope.TurnID,
		AttemptID: bootstrap.AttemptID, Generation: bootstrap.Generation,
		App: "web", HeadCommit: strings.Repeat("c", 40),
	}
	fixture.receive(t, nativeBrowserFrame{Type: "relay-error", ID: "unknown", Error: "unrelated"})
	fixture.receive(t, nativeBrowserFrame{Type: "inspection-context", ID: inspection.ID, Context: expectedContext})
	headers := http.Header{
		"Content-Type": {"text/plain"}, "X-App": {"first", "second"},
		"Set-Cookie": {
			"session=owned; Path=/private; HttpOnly",
			"theme=light; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
		},
	}
	fixture.receive(t, nativeBrowserFrame{Type: "app-head", ID: app.ID, Status: 201, Headers: headers})
	response := nativeBrowserUnitAwaitTrip(t, httpResult)
	if response.err != nil || response.response == nil {
		t.Fatal("App headers did not stream before end", response.err)
	}
	defer response.response.Body.Close()
	if response.response.StatusCode != 201 || !reflect.DeepEqual(response.response.Header, headers) {
		t.Fatal("multi-valued App response headers or cookies were flattened")
	}
	// Deliver all data and end before reading, including a final buffered frame.
	// One-byte reads also exercise the remainder of an already selected chunk.
	for _, chunk := range []string{"first-", "final"} {
		fixture.receive(t, nativeBrowserFrame{Type: "app-data", ID: app.ID, Data: base64.StdEncoding.EncodeToString([]byte(chunk))})
	}
	fixture.receive(t, nativeBrowserFrame{Type: "app-end", ID: app.ID})
	var body strings.Builder
	buffer := make([]byte, 1)
	for {
		count, err := response.response.Body.Read(buffer)
		body.Write(buffer[:count])
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if body.String() != "first-final" {
		t.Fatal("normal end lost the final buffered App data", body.String())
	}
	select {
	case result := <-observed:
		if result.err != nil || !reflect.DeepEqual(result.value, expectedContext) {
			t.Fatal("inspection response crossed into the App stream", result.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("inspection response did not settle")
	}
	response.response.Body.Close()
	fixture.noPending(t)
}

func TestNativeBrowserPeerUnitCanonicalizesLowercaseResponseHeaders(t *testing.T) {
	fixture := newNativeBrowserUnitPeer(t)
	result := fixture.roundTrip(nativeBrowserUnitHTTPRequest(t, "GET", "http://127.0.0.1:3000/", nil))
	request := fixture.frame(t)
	cookies := []string{
		"session=owned; Path=/private; HttpOnly",
		"theme=light; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
	}
	fixture.receive(t, nativeBrowserFrame{Type: "app-head", ID: request.ID, Status: 200, Headers: http.Header{
		"content-type": {"text/plain"}, "set-cookie": cookies, "x-app": {"first", "second"},
	}})
	response := nativeBrowserUnitAwaitTrip(t, result)
	if response.err != nil || response.response == nil {
		t.Fatal("lowercase response headers were not accepted", response.err)
	}
	defer response.response.Body.Close()
	expected := http.Header{
		"Content-Type": {"text/plain"}, "Set-Cookie": cookies, "X-App": {"first", "second"},
	}
	if !reflect.DeepEqual(response.response.Header, expected) ||
		response.response.Header.Get("Content-Type") != "text/plain" ||
		!reflect.DeepEqual(response.response.Header.Values("Set-Cookie"), cookies) {
		t.Fatal("lowercase wire headers lost canonical lookup, repeated values or separate cookies")
	}
	fixture.receive(t, nativeBrowserFrame{Type: "app-end", ID: request.ID})
	if data, err := io.ReadAll(response.response.Body); err != nil || len(data) != 0 {
		t.Fatal("empty response did not end after lowercase headers", err)
	}
	response.response.Body.Close()
	fixture.noPending(t)
}

func TestNativeBrowserPeerUnitProxyRelaysReadsAndWrites(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			proxy, err := newNativeBrowserAppProxy(fixture.peer.ctx, nativeBrowserUnitBootstrap().Apps, fixture.peer)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(proxy.close)
			replied := make(chan error, 1)
			fixture.jobs.Add(1)
			go func() {
				defer fixture.jobs.Done()
				_ = fixture.remote.SetReadDeadline(time.Now().Add(time.Second))
				var request nativeBrowserFrame
				if err := fixture.remote.ReadJSON(&request); err != nil {
					replied <- err
					return
				}
				if request.Type != "app-request" || request.Method != method || request.App != "web" ||
					request.Path != "/screen?q=owned" {
					replied <- errors.New("native App request changed its method, destination or path")
					return
				}
				frames := []nativeBrowserFrame{{Type: "app-head", ID: request.ID, Status: 200,
					Headers: http.Header{"Content-Type": {"text/plain"}}}}
				if method != http.MethodHead {
					frames = append(frames, nativeBrowserFrame{Type: "app-data", ID: request.ID,
						Data: base64.StdEncoding.EncodeToString([]byte("original App response"))})
				}
				frames = append(frames, nativeBrowserFrame{Type: "app-end", ID: request.ID})
				for _, frame := range frames {
					if err := fixture.peer.receive(frame); err != nil {
						replied <- err
						return
					}
				}
				replied <- nil
			}()
			response := httptest.NewRecorder()
			proxy.ServeHTTP(response, httptest.NewRequest(method, "http://web.factory.invalid/screen?q=owned", nil))
			relayError := <-replied
			if response.Code != http.StatusOK || relayError != nil {
				t.Fatalf("%s bypassed native App relay: HTTP %d, body %q, relay %v",
					method, response.Code, response.Body.String(), relayError)
			}
			if method != http.MethodHead && response.Body.String() != "original App response" {
				t.Fatal("native App proxy lost the original response")
			}
			fixture.noPending(t)
		})
	}
}

func TestNativeBrowserPeerUnitFastBufferedHeadAndEnd(t *testing.T) {
	for _, test := range []struct {
		name   string
		method string
		status int
		chunks []string
	}{
		{"204-no-body", http.MethodGet, http.StatusNoContent, nil},
		{"head-no-body", http.MethodHead, http.StatusOK, nil},
		{"small-body", http.MethodGet, http.StatusOK, []string{"small-", "final"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			gate := &nativeBrowserUnitWriteGate{}
			fixture := newNativeBrowserUnitPeerWithWriteGate(t, gate)
			cookies := []string{
				"session=owned; Path=/; HttpOnly",
				"init=ready; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
			}
			const attempts = 64
			lost := 0
			var firstError error
			for iteration := range attempts {
				resume := gate.pauseNextWrite(t)
				result := fixture.roundTrip(nativeBrowserUnitHTTPRequest(t, test.method, "http://127.0.0.1:3000/init", nil))
				request := fixture.frame(t)
				if request.Type != "app-request" || request.Method != test.method {
					t.Fatal("buffered response did not follow its actual App request")
				}
				fixture.receive(t, nativeBrowserFrame{Type: "app-head", ID: request.ID, Status: test.status,
					Headers: http.Header{"set-cookie": cookies, "x-app": {"ready"}}})
				for _, chunk := range test.chunks {
					fixture.receive(t, nativeBrowserFrame{Type: "app-data", ID: request.ID,
						Data: base64.StdEncoding.EncodeToString([]byte(chunk))})
				}
				fixture.receive(t, nativeBrowserFrame{Type: "app-end", ID: request.ID})
				fixture.peer.mu.Lock()
				pending := fixture.peer.pending[request.ID]
				fixture.peer.mu.Unlock()
				if pending == nil || len(pending.first) != 1 || len(pending.data) != len(test.chunks) {
					t.Fatal("test did not buffer the complete response before RoundTrip resumed")
				}
				select {
				case <-pending.done:
				default:
					t.Fatal("test did not end the response before RoundTrip resumed")
				}
				// Both first and done are ready before the production select.
				// Repetition catches its random choice, without scheduler sleeps
				// or changing global GOMAXPROCS.
				resume()
				response := nativeBrowserUnitAwaitTrip(t, result)
				if response.err != nil {
					lost++
					if firstError == nil {
						firstError = response.err
					}
					if response.response != nil {
						response.response.Body.Close()
						t.Fatal("failed RoundTrip also exposed a response")
					}
				} else {
					if response.response == nil {
						t.Fatal("successful RoundTrip returned no response")
					}
					data, err := io.ReadAll(response.response.Body)
					response.response.Body.Close()
					if err != nil || string(data) != strings.Join(test.chunks, "") ||
						response.response.StatusCode != test.status ||
						response.response.Header.Get("X-App") != "ready" ||
						!reflect.DeepEqual(response.response.Header.Values("Set-Cookie"), cookies) {
						t.Fatalf("iteration %d lost buffered status, headers/cookies or final body: %q, %v", iteration, data, err)
					}
				}
				if canceled := fixture.frame(t); canceled.Type != "relay-cancel" || canceled.ID != request.ID {
					t.Fatal("completed response did not release its original relay")
				}
				fixture.noPending(t)
			}
			if lost != 0 {
				t.Fatalf("RoundTrip discarded valid buffered app-head after app-end on %d/%d attempts: %v",
					lost, attempts, firstError)
			}
		})
	}
}

func TestNativeBrowserPeerUnitAcceptsExactRequestAndDataFrameBounds(t *testing.T) {
	fixture := newNativeBrowserUnitPeer(t)
	request := nativeBrowserUnitHTTPRequest(t, "POST", "http://127.0.0.1:3000/submit",
		strings.NewReader(strings.Repeat("x", maxBrowserRequestBytes)))
	result := fixture.roundTrip(request)
	frame := fixture.frame(t)
	body, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil || len(body) != maxBrowserRequestBytes {
		t.Fatal("request at its exact byte bound was truncated", err)
	}
	fixture.receive(t, nativeBrowserFrame{Type: "app-head", ID: frame.ID, Status: 200})
	response := nativeBrowserUnitAwaitTrip(t, result)
	if response.err != nil || response.response == nil {
		t.Fatal(response.err)
	}
	defer response.response.Body.Close()
	chunk := strings.Repeat("y", 64<<10)
	fixture.receive(t, nativeBrowserFrame{Type: "app-data", ID: frame.ID, Data: base64.StdEncoding.EncodeToString([]byte(chunk))})
	fixture.receive(t, nativeBrowserFrame{Type: "app-end", ID: frame.ID})
	data, err := io.ReadAll(response.response.Body)
	if err != nil || string(data) != chunk {
		t.Fatal("response frame at its exact byte bound was truncated", err)
	}
}

func TestNativeBrowserPeerUnitConstructorKeepsOnlyUniqueDeclaredAppTargets(t *testing.T) {
	for _, test := range []struct {
		name     string
		channels []protocol.Channel
	}{
		{"non-app", []protocol.Channel{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:4096"}}},
		{"external-target", []protocol.Channel{{Name: "web", Kind: "app", Target: "http://foreign.test:3000"}}},
		{"duplicate-loopback-port", []protocol.Channel{
			{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"},
			{Name: "other", Kind: "app", Target: "http://localhost:3000"},
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			peer, err := newNativeBrowserPeer(context.Background(), fixture.peer.connection,
				nativeBrowserUnitBootstrap().Scope, test.channels)
			if err == nil || peer != nil {
				if peer != nil {
					peer.close()
				}
				t.Fatal("relay constructor admitted a non-App or aliased destination")
			}
		})
	}
}

func TestNativeBrowserPeerUnitRejectsForeignTargetsAndUnsupportedRequests(t *testing.T) {
	for _, variant := range []string{"host", "port", "scheme", "userinfo", "connect", "upgrade", "headers", "body", "cancelled"} {
		t.Run(variant, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			address, method := "http://127.0.0.1:3000/", http.MethodGet
			switch variant {
			case "host":
				address = "http://foreign.test:3000/"
			case "port":
				address = "http://127.0.0.1:3001/"
			case "scheme":
				address = "https://127.0.0.1:3000/"
			case "userinfo":
				address = "http://user:password@127.0.0.1:3000/"
			case "connect":
				method = http.MethodConnect
			}
			request := nativeBrowserUnitHTTPRequest(t, method, address, nil)
			want := "not a supported declared App request"
			switch variant {
			case "upgrade":
				request.Header.Set("Upgrade", "websocket")
			case "headers":
				request.Header["Bad Header"] = []string{"owned"}
			case "body":
				request.Body = io.NopCloser(strings.NewReader(strings.Repeat("x", maxBrowserRequestBytes+1)))
				want = "request exceeds its bound"
			case "cancelled":
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				request = request.WithContext(ctx)
				want = "authority ended"
			}
			response, err := fixture.peer.RoundTrip(request)
			if response != nil || err == nil || !strings.Contains(err.Error(), want) {
				t.Fatal("unsupported request was not rejected before dispatch", err)
			}
			fixture.noPending(t)
		})
	}
}

func TestNativeBrowserPeerUnitHeaderWireBounds(t *testing.T) {
	tooMany := make(http.Header)
	for index := range 129 {
		tooMany["X-"+strings.Repeat("a", index+1)] = []string{"owned"}
	}
	values := make([]string, 65)
	for index := range values {
		values[index] = "owned"
	}
	for _, test := range []struct {
		name    string
		headers http.Header
		valid   bool
	}{
		{"multi-value-and-expiry", http.Header{"Set-Cookie": {"one=owned", "two=owned; Expires=Wed, 21 Oct 2037 07:28:00 GMT"}}, true},
		{"horizontal-tab-and-obs-text", http.Header{"X": {"owned\t\xff"}}, true},
		{"byte-limit", http.Header{"X": {strings.Repeat("x", (64<<10)-1)}}, true},
		{"byte-overflow", http.Header{"X": {strings.Repeat("x", 64<<10)}}, false},
		{"value-count-limit", http.Header{"X": values[:64]}, true},
		{"value-count-overflow", http.Header{"X": values}, false},
		{"header-count-overflow", tooMany, false},
		{"empty-name", http.Header{"": {"owned"}}, false},
		{"name-space", http.Header{"Bad Name": {"owned"}}, false},
		{"name-control", http.Header{"X-\x01": {"owned"}}, false},
		{"name-DEL", http.Header{"X-\x7f": {"owned"}}, false},
		{"name-non-ASCII", http.Header{"X-\u00e4": {"owned"}}, false},
		{"value-CRLF", http.Header{"X": {"owned\r\nInjected: true"}}, false},
		{"value-NUL", http.Header{"X": {"owned\x00"}}, false},
		{"value-control", http.Header{"X": {"owned\x1f"}}, false},
		{"value-DEL", http.Header{"X": {"owned\x7f"}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if validNativeBrowserHeaders(test.headers) != test.valid {
				t.Fatal("native Browser HTTP header validation lost its wire bounds")
			}
		})
	}
}

func TestNativeBrowserPeerUnitRejectsInvalidOrRepeatedResponseFrames(t *testing.T) {
	for _, variant := range []string{
		"data-before-head", "invalid-base64", "empty-data", "oversize-frame", "repeated-head",
		"invalid-status", "invalid-headers", "wrong-head-kind", "unsupported-frame", "end-before-head",
	} {
		t.Run(variant, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			result := fixture.roundTrip(nativeBrowserUnitHTTPRequest(t, "GET", "http://127.0.0.1:3000/", nil))
			request := fixture.frame(t)
			frame := nativeBrowserFrame{Type: "app-head", ID: request.ID, Status: 200}
			switch variant {
			case "data-before-head":
				frame.Type, frame.Data = "app-data", "eA=="
			case "invalid-status":
				frame.Status = 199
			case "invalid-headers":
				frame.Headers = http.Header{"Bad Name": {"owned"}}
			case "wrong-head-kind":
				frame.Type, frame.Context = "inspection-context", &browserInspectionContext{}
			case "end-before-head":
				frame.Type = "app-end"
			case "unsupported-frame":
				frame.Type = "unknown-response"
			}
			if variant == "data-before-head" || variant == "unsupported-frame" {
				if err := fixture.peer.receive(frame); err == nil {
					t.Fatal("invalid response sequencing was accepted")
				}
				fixture.peer.close()
			} else {
				fixture.receive(t, frame)
			}
			response := nativeBrowserUnitAwaitTrip(t, result)
			switch variant {
			case "data-before-head", "invalid-status", "invalid-headers", "wrong-head-kind", "unsupported-frame", "end-before-head":
				if response.err == nil || response.response != nil {
					t.Fatal("invalid response was exposed as HTTP success")
				}
				return
			}
			if response.err != nil || response.response == nil {
				t.Fatal(response.err)
			}
			defer response.response.Body.Close()
			frame = nativeBrowserFrame{Type: "app-data", ID: request.ID, Data: "eA=="}
			switch variant {
			case "invalid-base64":
				frame.Data = "not-base64!"
			case "empty-data":
				frame.Data = ""
			case "oversize-frame":
				frame.Data = base64.StdEncoding.EncodeToString(make([]byte, (64<<10)+1))
			case "repeated-head":
				frame.Type, frame.Status = "app-head", 200
			}
			if err := fixture.peer.receive(frame); err == nil {
				t.Fatal("malformed or repeated App data was accepted")
			}
		})
	}
}

func TestNativeBrowserPeerUnitResponseBudgetAndSlowConsumer(t *testing.T) {
	for _, overflow := range []bool{false, true} {
		t.Run(map[bool]string{false: "slow-consumer", true: "response-budget"}[overflow], func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			result := fixture.roundTrip(nativeBrowserUnitHTTPRequest(t, "GET", "http://127.0.0.1:3000/", nil))
			request := fixture.frame(t)
			fixture.receive(t, nativeBrowserFrame{Type: "app-head", ID: request.ID, Status: 200})
			response := nativeBrowserUnitAwaitTrip(t, result)
			if response.err != nil || response.response == nil {
				t.Fatal(response.err)
			}
			defer response.response.Body.Close()
			want, count := "too slow", 17
			if overflow {
				// Move to the aggregate boundary without allocating a 16 MiB
				// fixture. The real receive path must accept the boundary byte
				// and reject the next one independently of its frame bound.
				fixture.peer.mu.Lock()
				fixture.peer.pending[request.ID].bytes = protocol.MaxResponseBytes - 1
				fixture.peer.mu.Unlock()
				want, count = "exceeds its bound", 2
			}
			for range count {
				fixture.receive(t, nativeBrowserFrame{Type: "app-data", ID: request.ID, Data: "eA=="})
			}
			data, err := io.ReadAll(response.response.Body)
			expected := 16
			if overflow {
				expected = 1
			}
			if err == nil || !strings.Contains(err.Error(), want) || len(data) != expected {
				t.Fatal("response bound lost its buffered data or terminal error", len(data), err)
			}
		})
	}
}

func TestNativeBrowserPeerUnitCancellationDoesNotRetry(t *testing.T) {
	for _, afterHead := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-head", true: "streaming"}[afterHead], func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request := nativeBrowserUnitHTTPRequest(t, "POST", "http://127.0.0.1:3000/submit", strings.NewReader("one-mutation"))
			result := fixture.roundTrip(request.WithContext(ctx))
			frame := fixture.frame(t)
			if afterHead {
				fixture.receive(t, nativeBrowserFrame{Type: "app-head", ID: frame.ID, Status: 200})
				response := nativeBrowserUnitAwaitTrip(t, result)
				if response.err != nil || response.response == nil {
					t.Fatal(response.err)
				}
				cancel()
				if _, err := response.response.Body.Read(make([]byte, 1)); !errors.Is(err, context.Canceled) {
					t.Fatal("cancelled stream retained authority", err)
				}
				response.response.Body.Close()
				response.response.Body.Close()
			} else {
				cancel()
				if response := nativeBrowserUnitAwaitTrip(t, result); response.err == nil || response.response != nil {
					t.Fatal("cancelled mutation was acknowledged")
				}
			}
			canceled := fixture.frame(t)
			if canceled.Type != "relay-cancel" || canceled.ID != frame.ID {
				t.Fatal("cancellation lost its original relay identity")
			}
			fixture.noPending(t)
			_ = fixture.remote.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
			var extra nativeBrowserFrame
			err := fixture.remote.ReadJSON(&extra)
			var timeout net.Error
			if !errors.As(err, &timeout) || !timeout.Timeout() {
				t.Fatal("cancelled mutation was retried or cancellation was duplicated", extra.Type, err)
			}
		})
	}
}

func TestNativeBrowserPeerUnitRelayErrorAndDisconnectAreNotSuccess(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "relay-error", true: "disconnect"}[disconnect], func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			result := fixture.roundTrip(nativeBrowserUnitHTTPRequest(t, "GET", "http://127.0.0.1:3000/", nil))
			frame := fixture.frame(t)
			if disconnect {
				fixture.peer.close()
			} else {
				fixture.receive(t, nativeBrowserFrame{Type: "relay-error", ID: frame.ID, Error: "private infrastructure credential"})
			}
			response := nativeBrowserUnitAwaitTrip(t, result)
			if response.err == nil || response.response != nil ||
				strings.Contains(response.err.Error(), "private infrastructure credential") {
				t.Fatal("unconfirmed relay fabricated success or exposed a private diagnostic")
			}
			fixture.noPending(t)
		})
	}
}

func TestNativeBrowserPeerUnitInspectionRejectsAnotherOwnerBeforeDispatch(t *testing.T) {
	fixture := newNativeBrowserUnitPeer(t)
	scope := nativeBrowserUnitBootstrap().Scope
	scope.TurnID = "01994a7d-0000-7000-8000-000000000099"
	if value, err := fixture.peer.observation(context.Background(), scope, "web"); err == nil || value != nil {
		t.Fatal("inspection accepted another execution owner")
	}
	fixture.noPending(t)
}

func TestNativeBrowserPeerUnitInspectionBufferedContextAndCancellation(t *testing.T) {
	for _, ended := range []string{"live", "request-ended", "peer-ended"} {
		t.Run(ended, func(t *testing.T) {
			bootstrap := nativeBrowserUnitBootstrap()
			for iteration := 0; iteration < 64; iteration++ {
				gate := &nativeBrowserUnitWriteGate{}
				fixture := newNativeBrowserUnitPeerWithWriteGate(t, gate)
				resume := gate.pauseNextWrite(t)
				ctx, cancel := context.WithCancel(context.Background())
				t.Cleanup(cancel)
				type observationResult struct {
					value *browserInspectionContext
					err   error
				}
				result := make(chan observationResult, 1)
				fixture.jobs.Add(1)
				go func() {
					defer fixture.jobs.Done()
					value, err := fixture.peer.observation(ctx, bootstrap.Scope, "web")
					result <- observationResult{value, err}
				}()
				request := fixture.frame(t)
				if request.Type != "inspection-request" {
					t.Fatal("Source callback was not dispatched exactly once", request.Type)
				}
				expected := &browserInspectionContext{
					SessionID: bootstrap.Scope.SessionID, TurnID: bootstrap.Scope.TurnID,
					AttemptID: bootstrap.AttemptID, Generation: bootstrap.Generation,
					App: "web", HeadCommit: strings.Repeat("c", 40),
				}
				fixture.receive(t, nativeBrowserFrame{Type: "inspection-context", ID: request.ID, Context: expected})
				if ended == "request-ended" {
					cancel()
					if !errors.Is(ctx.Err(), context.Canceled) || fixture.peer.ctx.Err() != nil {
						t.Fatal("test did not isolate request authority ending")
					}
				} else if ended == "peer-ended" {
					fixture.peer.close()
					if ctx.Err() != nil || fixture.peer.ctx.Err() == nil {
						t.Fatal("test did not isolate control connection ending")
					}
				}
				resume()
				select {
				case observed := <-result:
					if ended != "live" {
						if observed.err == nil || observed.value != nil {
							t.Fatalf("iteration %d: cancelled Source inspection returned a context", iteration)
						}
					} else if observed.err != nil || !reflect.DeepEqual(observed.value, expected) {
						t.Fatalf("iteration %d: native Browser Source context is unavailable: %v", iteration, observed.err)
					}
				case <-time.After(2 * time.Second):
					cancel()
					t.Fatal("Source callback did not settle")
				}
				cancel()
				if ended != "peer-ended" {
					if released := fixture.frame(t); released.Type != "relay-cancel" || released.ID != request.ID {
						t.Fatal("Source callback did not release its own relay identity")
					}
				}
				fixture.noPending(t)
			}
		})
	}
}

func TestNativeBrowserPeerUnitInspectionUnavailableConditions(t *testing.T) {
	for _, ended := range []string{"callback-error", "missing-context", "request-cancelled", "wire-eof"} {
		t.Run(ended, func(t *testing.T) {
			fixture := newNativeBrowserUnitPeer(t)
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			type observationResult struct {
				value *browserInspectionContext
				err   error
			}
			result := make(chan observationResult, 1)
			fixture.jobs.Add(1)
			go func() {
				defer fixture.jobs.Done()
				value, err := fixture.peer.observation(ctx, nativeBrowserUnitBootstrap().Scope, "web")
				result <- observationResult{value, err}
			}()
			request := fixture.frame(t)
			if request.Type != "inspection-request" {
				t.Fatal("Source callback was not dispatched")
			}
			switch ended {
			case "callback-error":
				fixture.receive(t, nativeBrowserFrame{Type: "relay-error", ID: request.ID, Error: "private Source diagnostic"})
			case "missing-context":
				fixture.receive(t, nativeBrowserFrame{Type: "inspection-context", ID: request.ID})
			case "request-cancelled":
				cancel()
			case "wire-eof":
				// Exercise a real WebSocket read ending, not just a synthetic
				// relay-error. The gateway closes its peer on that same boundary.
				fixture.jobs.Add(1)
				go func() {
					defer fixture.jobs.Done()
					defer fixture.peer.close()
					_, _, _ = fixture.peer.connection.ReadMessage()
				}()
				fixture.remote.Close()
			}
			select {
			case observed := <-result:
				if observed.value != nil || observed.err == nil ||
					observed.err.Error() != "native Browser Source context is unavailable" {
					t.Fatal("Source failure fabricated success or exposed a private diagnostic", observed.err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Source failure did not settle")
			}
			fixture.noPending(t)
		})
	}
}
