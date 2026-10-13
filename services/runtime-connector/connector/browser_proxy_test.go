package connector

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testBrowserProxy(t *testing.T, ctx context.Context, app *httptest.Server) *browserAppProxy {
	t.Helper()
	target, err := url.Parse(app.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := newBrowserAppProxy(ctx, []Channel{
		{Name: "web", Kind: "app", Target: app.URL},
		{Name: "ide", Kind: "ide", Target: "http://127.0.0.1:15100"},
		{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:15101"},
	}, "172.18.0.2")
	if err != nil {
		t.Fatal(err)
	}
	proxy.transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != net.JoinHostPort("172.18.0.2", target.Port()) {
			t.Errorf("proxy dialled unassigned destination %q", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, target.Host)
	}
	t.Cleanup(proxy.close)
	return proxy
}

func TestBrowserLoopbackProxyReachesAnAppBoundOnlyToLocalhost(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "loopback-only App")
	}))
	defer app.Close()
	proxy, err := newBrowserLoopbackAppProxy(context.Background(), []Channel{
		{Name: "web", Kind: "app", Target: app.URL},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	record := httptest.NewRecorder()
	proxy.ServeHTTP(record, httptest.NewRequest("GET", "http://web.factory.invalid/", nil))
	if record.Code != 200 || record.Body.String() != "loopback-only App" {
		t.Fatalf("loopback-only App unavailable: %d %s", record.Code, record.Body.String())
	}
}

func TestBrowserProxyPinsAppDestinationAndDoesNotUseEnvironmentProxy(t *testing.T) {
	var hits atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Proxy-Authorization") != "" || r.Header.Get("X-Forwarded-Host") != "" {
			t.Error("proxy credentials or spoofed routing headers reached the App")
		}
		io.WriteString(w, r.URL.RequestURI())
	}))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	if proxy.transport.Proxy != nil {
		t.Fatal("environment proxy must not control App routing")
	}
	for _, origin := range []string{"http://web.factory.invalid", app.URL} {
		record := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, origin+"/screen?q=1", nil)
		r.Header.Set("Proxy-Authorization", "must-not-leave-browser")
		r.Header.Set("X-Forwarded-Host", "another-project.invalid")
		proxy.ServeHTTP(record, r)
		if record.Code != 200 || record.Body.String() != "/screen?q=1" {
			t.Fatalf("declared App failed: %d %q", record.Code, record.Body.String())
		}
	}
	if hits.Load() != 2 {
		t.Fatal("declared requests did not reach the exact App")
	}
}

func TestBrowserProxyDeniesInfrastructureFilesOtherOriginsAndTunnelsBeforeDial(t *testing.T) {
	var hits atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	for _, target := range []string{
		"http://127.0.0.1:15100/", "http://127.0.0.1:15101/",
		"http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/",
		"http://10.0.0.1/", "http://172.18.0.2/", "http://[::1]:15100/",
		"http://2130706433:15100/", "http://web.factory.invalid:3000/",
		"http://web.factory.invalid.evil.invalid/", "http://other.factory.invalid/",
		"https://web.factory.invalid/", "file:///etc/passwd",
		"http://user:password@web.factory.invalid/",
	} {
		t.Run(target, func(t *testing.T) {
			record := httptest.NewRecorder()
			proxy.ServeHTTP(record, httptest.NewRequest(http.MethodGet, target, nil))
			if record.Code != 403 || strings.Contains(record.Body.String(), "password") {
				t.Fatalf("target denial or redaction failed: %d %q", record.Code, record.Body.String())
			}
		})
	}
	for _, method := range []string{http.MethodConnect, http.MethodTrace} {
		record := httptest.NewRecorder()
		proxy.ServeHTTP(record, httptest.NewRequest(method, "http://web.factory.invalid/", nil))
		if record.Code != 403 {
			t.Fatal("tunnel or TRACE accepted")
		}
	}
	if hits.Load() != 0 {
		t.Fatal("a denied request reached an App")
	}
}

func TestBrowserProxyRejectsRedirectBeforeFollowingAndRetainsDeclaredRelativeRedirect(t *testing.T) {
	var escaped atomic.Int32
	infrastructure := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { escaped.Add(1) }))
	defer infrastructure.Close()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/escape" {
			http.Redirect(w, r, infrastructure.URL+"/secret", 302)
		} else if r.URL.Path == "/relative" {
			http.Redirect(w, r, "/allowed?view=1", 302)
		} else {
			io.WriteString(w, "declared App")
		}
	}))
	defer app.Close()
	proxy := httptest.NewServer(testBrowserProxy(t, context.Background(), app))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	for _, path := range []string{"escape", "relative"} {
		response, err := client.Get("http://web.factory.invalid/" + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if path == "escape" && response.StatusCode != 403 {
			t.Fatal("undeclared redirect was followed")
		}
		if path == "relative" && (response.StatusCode != 200 || string(body) != "declared App") {
			t.Fatal("declared redirect failed")
		}
	}
	if escaped.Load() != 0 {
		t.Fatal("redirect reached infrastructure")
	}
}

func TestBrowserProxyRejectsChunkedOversizeBeforeAnyAppWrite(t *testing.T) {
	var hits atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	request := httptest.NewRequest(http.MethodPost, "http://web.factory.invalid/write", strings.NewReader(strings.Repeat("x", maxBrowserRequestBytes+1)))
	request.ContentLength = -1
	request.TransferEncoding = []string{"chunked"}
	record := httptest.NewRecorder()
	proxy.ServeHTTP(record, request)
	if record.Code != 413 || hits.Load() != 0 {
		t.Fatal("oversized body reached an App")
	}
}

func TestBrowserProxyRevocationClosesWebSocketAndRejectsFurtherRequests(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			kind, body, err := connection.ReadMessage()
			if err != nil {
				return
			}
			if connection.WriteMessage(kind, body) != nil {
				return
			}
		}
	}))
	defer app.Close()
	handler := testBrowserProxy(t, ctx, app)
	proxy := httptest.NewServer(handler)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	request, _ := http.NewRequest(http.MethodGet, "http://web.factory.invalid/live", nil)
	requestCtx, cancelRequest := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelRequest()
	request = request.WithContext(requestCtx)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	request.Header.Set("Origin", "http://web.factory.invalid")
	// Chrome uses HTTP Upgrade through its HTTP proxy. Gorilla's proxy dialer
	// instead attempts an unrestricted CONNECT tunnel, which must stay denied.
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 101 {
		t.Fatalf("App WebSocket upgrade failed: %d", response.StatusCode)
	}
	connection, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		t.Fatal("upgrade did not return a bidirectional connection")
	}
	body := []byte("before Stop")
	frame := append([]byte{0x81, 0x80 | byte(len(body)), 0, 0, 0, 0}, body...)
	if _, err := connection.Write(frame); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, len(body)+2)
	if _, err := io.ReadFull(connection, echo); err != nil || string(echo[2:]) != string(body) {
		t.Fatal(err)
	}
	cancel()
	closed := make(chan error, 1)
	go func() {
		_, err := connection.Read(make([]byte, 1))
		closed <- err
	}()
	select {
	case err := <-closed:
		if err == nil {
			t.Fatal("WebSocket retained authority after Stop")
		}
	case <-time.After(time.Second):
		t.Fatal("revocation did not close the connection within one second")
	}
	record := httptest.NewRecorder()
	handler.ServeHTTP(record, httptest.NewRequest(http.MethodGet, "http://web.factory.invalid/", nil))
	if record.Code != 410 {
		t.Fatal("new request accepted after authority ended")
	}
}

func TestBrowserProxyRevocationInterruptsAnIncompleteRequestBody(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var hits atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer app.Close()
	proxy := testBrowserProxy(t, ctx, app)
	body, writer := io.Pipe()
	defer writer.Close()
	request := httptest.NewRequest(http.MethodPost, "http://web.factory.invalid/write", nil)
	request.Body = body
	request.ContentLength = -1
	record := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		proxy.ServeHTTP(record, request)
		close(done)
	}()
	if _, err := writer.Write([]byte("partial")); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-done:
		if record.Code != 410 || hits.Load() != 0 {
			t.Fatal("incomplete request retained authority after Stop")
		}
	case <-time.After(time.Second):
		t.Fatal("revocation did not interrupt body read")
	}
}

func TestBrowserProxyRefusesUninspectedOrAmbiguousDestinations(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "169.254.169.254", "8.8.8.8", "primary-container", ""} {
		if _, err := newBrowserAppProxy(context.Background(), []Channel{{Name: "app", Kind: "app", Target: "http://localhost:4300"}}, address); err == nil {
			t.Fatalf("accepted uninspected primary IP %q", address)
		}
	}
	for _, channels := range [][]Channel{
		{{Name: "ide", Kind: "ide", Target: "http://localhost:15100"}},
		{{Name: "web", Kind: "app", Target: "http://8.8.8.8:4300"}},
		{{Name: "web", Kind: "app", Target: "http://localhost:70000"}},
		{{Name: "web", Kind: "app", Target: "http://localhost:4300"}, {Name: "other", Kind: "app", Target: "http://localhost:4300"}},
	} {
		if _, err := newBrowserAppProxy(context.Background(), channels, "172.18.0.2"); err == nil {
			t.Fatal("accepted invalid or ambiguous App channels")
		}
	}
}

func TestBrowserLoopbackBridgeRetainsOriginAndUsesOnlyAssignedUnixSocket(t *testing.T) {
	var hits atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		io.WriteString(w, "declared App through Unix")
	}))
	defer app.Close()
	directory, err := os.MkdirTemp("", "fbp-")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(directory, "proxy.sock")
	t.Cleanup(func() {
		os.Remove(socket)
		os.Remove(directory)
	})
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	outer := &http.Server{Handler: testBrowserProxy(t, context.Background(), app), ReadHeaderTimeout: time.Second}
	go outer.Serve(listener)
	defer outer.Close()
	handler, transport := newBrowserLoopbackBridge(socket)
	defer transport.CloseIdleConnections()
	bridge := httptest.NewServer(handler)
	defer bridge.Close()
	bridgeURL, _ := url.Parse(bridge.URL)
	browserTransport := &http.Transport{Proxy: http.ProxyURL(bridgeURL)}
	defer browserTransport.CloseIdleConnections()
	client := &http.Client{Transport: browserTransport, Timeout: time.Second}
	for target, status := range map[string]int{
		"http://web.factory.invalid/":      200,
		"http://127.0.0.1:15100/":          403,
		"http://169.254.169.254/metadata/": 403,
		"http://other.factory.invalid/":    403,
	} {
		response, err := client.Get(target)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("Unix bridge changed origin/denial: %d, expected %d", response.StatusCode, status)
		}
	}
	if hits.Load() != 1 {
		t.Fatal("Unix bridge dialled an undeclared App")
	}
}
