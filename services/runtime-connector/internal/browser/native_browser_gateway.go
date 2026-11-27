package browser

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

const (
	nativeBrowserPath     = "/internal/factory-browser"
	nativeBrowserProtocol = "factory-native-browser-v1"
	nativeBrowserMaxFrame = 4 << 20
)

type nativeBrowserBootstrap struct {
	Version    int                   `json:"version"`
	AttemptID  string                `json:"runtimeAttemptId"`
	Generation uint64                `json:"generation"`
	Scope      browserRuntimeRequest `json:"scope"`
	Apps       []protocol.Channel    `json:"apps"`
	Token      string                `json:"token"`
}

func (bootstrap nativeBrowserBootstrap) validate() error {
	if bootstrap.Version != 1 || !protocol.UUIDPattern.MatchString(bootstrap.AttemptID) ||
		bootstrap.Generation == 0 || !protocol.UUIDPattern.MatchString(bootstrap.Scope.SessionID) ||
		!protocol.UUIDPattern.MatchString(bootstrap.Scope.TurnID) ||
		!browserOwnerPattern.MatchString(bootstrap.Scope.OwnerID) ||
		!strings.HasPrefix(bootstrap.Scope.AgentSessionID, "ses") || len(bootstrap.Scope.AgentSessionID) > 200 ||
		!bootstrap.Scope.ExpiresAt.IsZero() || bootstrap.Scope.Call.Name != "" ||
		!browserOwnerPattern.MatchString(bootstrap.Token) {
		return errors.New("invalid native Browser bootstrap scope")
	}
	_, err := browserWorkerArguments(bootstrap.Apps)
	return err
}

func RunNativeBrowserGateway(ctx context.Context) error {
	text := os.Getenv("FACTORY_NATIVE_BROWSER_BOOTSTRAP")
	os.Unsetenv("FACTORY_NATIVE_BROWSER_BOOTSTRAP")
	if os.Getpid() != 1 || os.Geteuid() != 0 || os.Getegid() != 0 || len(text) > 32<<10 {
		return errors.New("native Browser gateway requires its fixed root Actor entry")
	}
	var bootstrap nativeBrowserBootstrap
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&bootstrap) != nil || decoder.Decode(new(any)) != io.EOF || bootstrap.validate() != nil {
		return errors.New("invalid native Browser bootstrap")
	}
	identity, err := os.ReadFile("/run/ate/identity/uid")
	uid := strings.TrimSpace(string(identity))
	if err != nil || !protocol.UUIDPattern.MatchString(uid) {
		return errors.New("native Browser Actor identity is unavailable")
	}
	for _, path := range []string{"/factory", nativeBrowserDirectory, filepath.Join(nativeBrowserDirectory, "config")} {
		if err := os.MkdirAll(path, 0755); err != nil {
			return errors.New("native Browser control storage is unavailable")
		}
		if err := protectNativeBrowserDirectory(path); err != nil {
			return err
		}
	}
	handler := newNativeBrowserGateway(ctx, bootstrap, uid)
	server := &http.Server{Addr: ":80", Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10}
	finished := make(chan error, 1)
	go func() { finished <- server.ListenAndServe() }()
	select {
	case err := <-finished:
		return err
	case <-ctx.Done():
		handler.mu.Lock()
		handler.closing = true
		handler.mu.Unlock()
		server.Close()
		<-finished
		handler.handlers.Wait()
		return nil
	}
}

type nativeBrowserGateway struct {
	ctx       context.Context
	bootstrap nativeBrowserBootstrap
	uid       string
	connected atomic.Bool
	handlers  sync.WaitGroup
	mu        sync.Mutex
	closing   bool
}

func newNativeBrowserGateway(ctx context.Context, bootstrap nativeBrowserBootstrap, uid string) *nativeBrowserGateway {
	return &nativeBrowserGateway{ctx: ctx, bootstrap: bootstrap, uid: uid}
}

func (gateway *nativeBrowserGateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	gateway.mu.Lock()
	if gateway.closing {
		gateway.mu.Unlock()
		writer.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	gateway.handlers.Add(1)
	gateway.mu.Unlock()
	defer gateway.handlers.Done()
	if request.Method == http.MethodGet && request.URL.Path == "/readyz" && request.URL.RawQuery == "" {
		writer.WriteHeader(http.StatusOK)
		return
	}
	authorization := request.Header.Get("Authorization")
	expected := "Bearer " + gateway.bootstrap.Token
	protocols := websocket.Subprotocols(request)
	if request.Method != http.MethodGet || request.URL.Path != nativeBrowserPath || request.URL.RawQuery != "" ||
		request.Header.Get("Origin") != "" || len(request.Header.Values("Authorization")) != 1 ||
		len(authorization) != len(expected) || subtle.ConstantTimeCompare([]byte(authorization), []byte(expected)) != 1 ||
		len(request.Header.Values("X-Factory-Actor-UID")) != 1 || request.Header.Get("X-Factory-Actor-UID") != gateway.uid ||
		len(request.Header.Values("X-Factory-Browser-Session")) != 1 ||
		request.Header.Get("X-Factory-Browser-Session") != gateway.bootstrap.Scope.SessionID ||
		len(protocols) != 1 || protocols[0] != nativeBrowserProtocol {
		http.Error(writer, "native Browser scope is not admitted", http.StatusForbidden)
		return
	}
	if !gateway.connected.CompareAndSwap(false, true) {
		http.Error(writer, "native Browser requires original owned cleanup", http.StatusConflict)
		return
	}
	upgrader := websocket.Upgrader{Subprotocols: []string{nativeBrowserProtocol}}
	connection, err := upgrader.Upgrade(writer, request, http.Header{"X-Factory-Actor-Uid": {gateway.uid}})
	if err != nil {
		return
	}
	live, cancel := context.WithCancel(gateway.ctx)
	defer cancel()
	peer, err := newNativeBrowserPeer(live, connection, gateway.bootstrap.Scope, gateway.bootstrap.Apps)
	if err != nil {
		connection.Close()
		return
	}
	worker := newNativeBrowserWorker(live, protocol.Assignment{
		RuntimeAttemptID: gateway.bootstrap.AttemptID, Generation: gateway.bootstrap.Generation,
		Channels: gateway.bootstrap.Apps,
	}, gateway.bootstrap.Scope)
	worker.observe = peer.observation
	worker.startProxy = func(ctx context.Context) (func(), error) {
		proxy, err := newNativeBrowserAppProxy(ctx, gateway.bootstrap.Apps, peer)
		if err != nil {
			return nil, err
		}
		worker.httpRead = func(ctx context.Context, app string, after uint64) (json.RawMessage, error) {
			if ctx.Err() != nil || proxy.authority.Err() != nil || after > maxBrowserObservationCursor {
				return nil, errBrowserAuthorityEnded
			}
			if route, ok := proxy.routes["http://"+app+".factory.invalid"]; !ok || route.app != app {
				return nil, errBrowserTargetDenied
			}
			page, _ := json.Marshal(proxy.observationPage(app, after))
			return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": string(page)}}})
		}
		stop, err := serveNativeBrowserAppSocket(ctx, proxy)
		if err != nil {
			proxy.close()
			return nil, err
		}
		return func() { stop(); proxy.close() }, nil
	}
	// start validates the callback before it creates the proxy. This function
	// is replaced with the actual sanitized-ring reader during that startup.
	worker.httpRead = func(context.Context, string, uint64) (json.RawMessage, error) {
		return nil, errors.New("native Browser App observations are not ready")
	}
	defer worker.close()
	defer peer.close()
	if peer.send(nativeBrowserFrame{Type: "browser-connected", ActorUID: gateway.uid,
		SessionID: gateway.bootstrap.Scope.SessionID}) != nil {
		return
	}
	stop := context.AfterFunc(live, func() { connection.Close() })
	defer stop()
	connection.SetReadLimit(nativeBrowserMaxFrame)
	queue := make(chan protocol.Message, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-live.Done():
				return
			case operation := <-queue:
				if live.Err() != nil {
					return
				}
				response := worker.handle(live, operation)
				if peer.send(nativeBrowserFrame{Type: "operation-response", Operation: &response}) != nil {
					cancel()
					connection.Close()
					return
				}
			}
		}
	}()
	defer func() { cancel(); peer.close(); worker.runtime.cancel(); <-done }()
	seen := make(map[string]bool)
	for {
		kind, data, err := connection.ReadMessage()
		if err != nil {
			return
		}
		var frame nativeBrowserFrame
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if kind != websocket.TextMessage || decoder.Decode(&frame) != nil || decoder.Decode(new(any)) != io.EOF {
			return
		}
		if frame.Type != "operation-request" {
			if peer.receive(frame) != nil {
				return
			}
			continue
		}
		operation := frame.Operation
		if operation == nil || !protocol.UUIDPattern.MatchString(operation.OperationID) {
			return
		}
		scope, scopeError := decodeBrowserRuntimeRequest(*operation, worker.assignment)
		if scopeError != nil || !sameBrowserScope(scope, gateway.bootstrap.Scope) {
			response := protocol.Message{Type: "operation-response", OperationID: operation.OperationID,
				Action: operation.Action, Error: "browser operation does not match its admitted execution scope"}
			_ = peer.send(nativeBrowserFrame{Type: "operation-response", Operation: &response})
			continue
		}
		if operation.Action == "browser-renew" {
			response := worker.handle(live, *operation)
			if peer.send(nativeBrowserFrame{Type: "operation-response", Operation: &response}) != nil {
				return
			}
			continue
		}
		if operation.Action == "browser-close" {
			worker.runtime.cancel()
		}
		if seen[operation.OperationID] || len(seen) >= 16384 {
			response := protocol.Message{Type: "operation-response", OperationID: operation.OperationID,
				Action: operation.Action, Error: "browser operation was already dispatched or its scope ended"}
			_ = peer.send(nativeBrowserFrame{Type: "operation-response", Operation: &response})
			continue
		}
		seen[operation.OperationID] = true
		select {
		case queue <- *operation:
		default:
			response := protocol.Message{Type: "operation-response", OperationID: operation.OperationID,
				Action: operation.Action, Error: "browser operation queue is full"}
			_ = peer.send(nativeBrowserFrame{Type: "operation-response", Operation: &response})
		}
	}
}

func newNativeBrowserAppProxy(ctx context.Context, channels []protocol.Channel, peer *nativeBrowserPeer) (*browserAppProxy, error) {
	proxy, err := newBrowserLoopbackAppProxy(ctx, channels)
	if err != nil {
		return nil, err
	}
	// Transport.Clone does not copy registered protocols. Install the native
	// relay on both completed transports so GET/HEAD cannot dial loopback.
	proxy.transport.ordinary.RegisterProtocol("http", peer)
	proxy.transport.read.RegisterProtocol("http", peer)
	return proxy, nil
}

func serveNativeBrowserAppSocket(ctx context.Context, proxy *browserAppProxy) (func(), error) {
	listener, err := net.Listen("unix", browserSocketPath)
	if err != nil {
		return nil, errors.New("native Browser App socket is unavailable")
	}
	if os.Chmod(browserSocketPath, 0600) != nil || os.Chown(browserSocketPath, 1000, 1000) != nil {
		listener.Close()
		os.Remove(browserSocketPath)
		return nil, errors.New("native Browser App socket owner is unavailable")
	}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	var once sync.Once
	stop := func() {
		once.Do(func() { server.Close(); <-done; os.Remove(browserSocketPath) })
	}
	go func() { <-ctx.Done(); stop() }()
	return stop, nil
}
