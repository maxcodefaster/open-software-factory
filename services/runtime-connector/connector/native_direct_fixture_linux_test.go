package connector

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Explicit test-only control-plane peer for the native entrypoint proof. This
// is not Factory product authority acceptance: real database grants have their
// own controller tests. No arbitrary command or URL is accepted by this fixture.
func TestNativeDirectFactoryFixture(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_DIRECT_FIXTURE") != "1" {
		t.Skip("explicit native direct-entry fixture only")
	}
	if os.Getpid() != 1 || os.Geteuid() != 1000 {
		t.Fatal("fixture requires its own non-root native container")
	}
	var input struct {
		AttemptID   string            `json:"attemptID"`
		WorkspaceID string            `json:"workspaceID"`
		Parent      string            `json:"parent"`
		Child       string            `json:"child"`
		Observe     string            `json:"observe"`
		Entries     map[string]string `json:"entries"`
	}
	if json.Unmarshal([]byte(os.Getenv("FACTORY_NATIVE_DIRECT_INPUT")), &input) != nil ||
		input.Parent == "" || input.Child == "" || input.Observe == "" {
		t.Fatal("invalid fixed fixture identity")
	}
	os.Unsetenv("FACTORY_NATIVE_DIRECT_INPUT")
	type peer struct {
		conn *websocket.Conn
		send sync.Mutex
	}
	var mutex sync.Mutex
	peers := map[string]*peer{}
	pending := map[string]chan Message{}
	parentReady, childReady := false, false
	entries := map[string]int64{}
	var parentReadyAt int64
	var pendingReads int
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	route := func(message Message) string {
		if message.OperationID != "" {
			return message.OperationID
		}
		return message.StreamID
	}
	call := func(ctx context.Context, role string, message Message) ([]Message, error) {
		key := route(message)
		channel := make(chan Message, 64)
		mutex.Lock()
		target := peers[role]
		if target == nil || pending[key] != nil {
			mutex.Unlock()
			return nil, errors.New("fixture peer/operation unavailable")
		}
		pending[key] = channel
		mutex.Unlock()
		defer func() { mutex.Lock(); delete(pending, key); mutex.Unlock() }()
		target.send.Lock()
		err := target.conn.WriteJSON(message)
		target.send.Unlock()
		if err != nil {
			return nil, err
		}
		var messages []Message
		for {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case response := <-channel:
				messages = append(messages, response)
				if response.Type == "operation-response" || response.Type == "stream-end" || response.Type == "stream-error" {
					return messages, nil
				}
			}
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/runtime-connect", func(w http.ResponseWriter, r *http.Request) {
		role := r.Header.Get("X-Factory-Connector-Role")
		expected := map[string]string{"parent": input.Parent, "child": input.Child}[role]
		if expected == "" || r.Header.Get("Authorization") != "Bearer "+expected ||
			r.Header.Get("X-Factory-Runtime-Attempt") != input.AttemptID ||
			r.Header.Get("X-Factory-Runtime-Generation") != "1" ||
			!nativeProjectActorUID.MatchString(r.Header.Get("X-Factory-Runtime-Actor-UID")) {
			w.WriteHeader(403)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		current := &peer{conn: conn}
		mutex.Lock()
		peers[role] = current
		mutex.Unlock()
		defer func() {
			mutex.Lock()
			if peers[role] == current {
				delete(peers, role)
			}
			mutex.Unlock()
		}()
		for {
			var message Message
			if conn.ReadJSON(&message) != nil {
				return
			}
			mutex.Lock()
			if message.Type == "hello" && message.Role == role {
				if role == "parent" {
					for _, c := range message.Channels {
						if c.Name == "source" {
							parentReady = true
							parentReadyAt = time.Now().UnixNano()
						}
					}
				} else {
					childReady = true
				}
			}
			response := pending[route(message)]
			mutex.Unlock()
			if response != nil {
				select {
				case response <- message:
				default:
					t.Error("fixture response bound exceeded")
				}
			}
		}
	})
	mux.HandleFunc("/internal/runtime-environment/"+input.AttemptID, func(w http.ResponseWriter, r *http.Request) {
		name := r.Header.Get("X-Factory-Runtime-Container")
		expected := input.Entries[name]
		if r.Method != "GET" || expected == "" || r.Header.Get("Authorization") != "Bearer "+expected ||
			r.Header.Get("X-Factory-Runtime-Generation") != "1" ||
			!nativeProjectActorUID.MatchString(r.Header.Get("X-Factory-Runtime-Actor-UID")) {
			w.WriteHeader(403)
			return
		}
		mutex.Lock()
		ready := parentReady
		if !ready {
			pendingReads++
		} else {
			entries[name] = time.Now().UnixNano()
		}
		mutex.Unlock()
		if !ready {
			w.WriteHeader(409)
			return
		}
		json.NewEncoder(w).Encode(runtimeEnvironment{Version: 0, Bundle: environmentBundle{
			Variables: []environmentVariable{{Name: "POSTGRES_PASSWORD", Value: "owned-native-database", Runtime: true},
				{Name: "PROOF_RUNTIME_NONCE", Value: "runtime-only-entry", Runtime: true}},
		}})
	})
	mux.HandleFunc("/proof/state", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+input.Observe {
			w.WriteHeader(401)
			return
		}
		mutex.Lock()
		defer mutex.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"parentReady": parentReady, "childReady": childReady,
			"parentReadyAt": parentReadyAt, "entryGrants": entries, "pendingReads": pendingReads})
	})
	mux.HandleFunc("/proof/checkpoint", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+input.Observe {
			w.WriteHeader(401)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		identity := "05bacf2a-3223-47e3-bb75-273f049cfd8f"
		var results []Message
		for _, request := range []struct {
			role    string
			message Message
		}{
			{"child", Message{Type: "operation-request", OperationID: identity, Action: "source-drain"}},
			{"parent", Message{Type: "operation-request", OperationID: identity, Action: "source-drain", Data: identity}},
			{"parent", Message{Type: "http-request", StreamID: identity, Channel: "source", Method: "POST",
				Path: "/v1/workspaces/" + input.WorkspaceID + "/checkpoint", Headers: map[string]string{"x-factory-writer-epoch": "1"},
				Data: base64.StdEncoding.EncodeToString([]byte(`{"checkpointId":"` + identity + `","writerEpoch":1}`))}},
		} {
			messages, err := call(ctx, request.role, request.message)
			if err != nil {
				http.Error(w, err.Error(), 503)
				return
			}
			results = append(results, messages...)
			for _, message := range messages {
				if message.Error != "" {
					json.NewEncoder(w).Encode(map[string]any{"confirmed": false, "messages": results})
					return
				}
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"confirmed": true, "messages": results})
	})
	lifetime, cancel := signal.NotifyContext(t.Context(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	ctx, stop := context.WithTimeout(lifetime, 6*time.Minute)
	defer stop()
	secure := &http.Server{Addr: ":18443", Handler: mux, ReadHeaderTimeout: time.Second,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	observe := &http.Server{Addr: ":18444", Handler: mux, ReadHeaderTimeout: time.Second}
	go func() {
		if err := secure.ListenAndServeTLS("/fixture-cert.pem", "/fixture-key.pem"); err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Error(err)
			stop()
		}
	}()
	go func() {
		if err := observe.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Error(err)
			stop()
		}
	}()
	<-ctx.Done()
	secure.Close()
	observe.Close()
	mutex.Lock()
	for _, peer := range peers {
		peer.conn.Close()
	}
	mutex.Unlock()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("owned native fixture lifetime expired")
	}
}
