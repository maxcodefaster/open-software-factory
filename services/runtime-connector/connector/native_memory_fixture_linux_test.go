package connector

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

type nativeMemorySourceReceipt struct {
	Version       int                   `json:"version"`
	AttemptID     string                `json:"attemptID"`
	Seed          sourceRestoreResponse `json:"seed"`
	Imported      bool                  `json:"imported"`
	ModelRequests int                   `json:"modelRequests,omitempty"`
}

// The caller holds the fixture mutex. The immutable seed is needed only for
// first import and exact lost-ACK retries, never ordinary native continuation.
func nativeMemorySourceHandler(saved *nativeMemorySourceReceipt, parent, archive string, persist func() error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		seed := saved.Seed
		if r.URL.Path != "/internal/substrate-source/"+saved.AttemptID ||
			r.Header.Get("Authorization") != "Bearer "+parent ||
			r.Header.Get("X-Factory-Runtime-Actor-UID") != seed.ActorUID ||
			r.Header.Get("X-Factory-Runtime-Generation") != "1" ||
			r.Header.Get("X-Factory-Source-Protocol") != "2" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost {
			var commit struct {
				ID    string `json:"checkpointID"`
				Epoch uint64 `json:"writerEpoch"`
			}
			d := json.NewDecoder(io.LimitReader(r.Body, 4097))
			d.DisallowUnknownFields()
			if r.URL.RawQuery != "" || d.Decode(&commit) != nil || d.Decode(new(any)) != io.EOF ||
				commit.ID != seed.Checkpoint.ID || commit.Epoch != seed.WriterEpoch {
				w.WriteHeader(http.StatusConflict)
				return
			}
			if !saved.Imported {
				saved.Imported = true
				if err := persist(); err != nil {
					saved.Imported = false
					http.Error(w, "owned Source receipt could not persist", http.StatusServiceUnavailable)
					return
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"version": 2, "actorUID": seed.ActorUID,
				"checkpointID": commit.ID, "writerEpoch": commit.Epoch,
				"changeWriterEpoch": seed.ChangeWriterEpoch, "readOnly": seed.ReadOnly})
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.URL.RawQuery == "" {
			if saved.Imported {
				json.NewEncoder(w).Encode(map[string]any{"version": 2, "retained": true, "actorUID": seed.ActorUID,
					"writerEpoch": seed.WriterEpoch, "changeWriterEpoch": seed.ChangeWriterEpoch,
					"readOnly": seed.ReadOnly, "checkpoint": nil})
			} else {
				json.NewEncoder(w).Encode(seed)
			}
			return
		}
		index, err := strconv.Atoi(r.URL.Query().Get("chunk"))
		if saved.Imported || err != nil || index < 0 || index >= len(seed.Checkpoint.Bundle.Chunks) ||
			r.URL.Query().Get("checkpoint") != seed.Checkpoint.ID ||
			r.Header.Get("X-Factory-Source-Writer-Epoch") != strconv.FormatUint(seed.WriterEpoch, 10) {
			w.WriteHeader(http.StatusConflict)
			return
		}
		file, err := os.Open(archive)
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		defer file.Close()
		start := int64(index) * workspacefiles.SourceChunkBytes
		io.CopyN(w, io.NewSectionReader(file, start, seed.Checkpoint.Bundle.Bytes-start),
			min(int64(workspacefiles.SourceChunkBytes), seed.Checkpoint.Bundle.Bytes-start))
	}
}

func TestNativeMemorySourceLeaseFirstImportOnlyContract(t *testing.T) {
	seed := sourceRestoreV2TestLease(t)
	digest := sha256.Sum256([]byte("seeddata"))
	seed.Checkpoint.Bundle.SHA256 = hex.EncodeToString(digest[:])
	seed.Checkpoint.Bundle.Chunks = []string{seed.Checkpoint.Bundle.SHA256}
	saved := nativeMemorySourceReceipt{Version: 1, AttemptID: "owned-attempt", Seed: seed}
	file, err := os.CreateTemp(t.TempDir(), "initial-seed-")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("seeddata"); err != nil {
		t.Fatal(err)
	}
	file.Close()
	var persisted []byte
	var commits int
	handler := nativeMemorySourceHandler(&saved, "owned-parent", file.Name(), func() error {
		commits++
		persisted, err = json.Marshal(saved)
		return err
	})
	request := func(method, query, body string) *http.Request {
		r := httptest.NewRequest(method, "https://fixture.invalid/internal/substrate-source/owned-attempt"+query, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer owned-parent")
		r.Header.Set("X-Factory-Runtime-Actor-UID", seed.ActorUID)
		r.Header.Set("X-Factory-Runtime-Generation", "1")
		r.Header.Set("X-Factory-Source-Protocol", "2")
		r.Header.Set("X-Factory-Source-Writer-Epoch", "2")
		return r
	}
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	if w := serve(request(http.MethodGet, "", "")); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), seed.Checkpoint.ID) || saved.Imported {
		t.Fatal("first lease did not offer only its immutable seed")
	}
	chunk := "?chunk=0&checkpoint=" + seed.Checkpoint.ID
	if w := serve(request(http.MethodGet, chunk, "")); w.Code != http.StatusOK || w.Body.String() != "seeddata" {
		t.Fatal("first import could not download its real seed bytes")
	}
	body := `{"checkpointID":"` + seed.Checkpoint.ID + `","writerEpoch":2}`
	for _, invalid := range []string{
		`{"checkpointID":"foreign","writerEpoch":2}`,
		`{"checkpointID":"` + seed.Checkpoint.ID + `","writerEpoch":3}`,
		strings.TrimSuffix(body, "}") + `,"obsolete":true}`,
	} {
		if w := serve(request(http.MethodPost, "", invalid)); w.Code != http.StatusConflict || saved.Imported {
			t.Fatal("unbound first import acquired retained ownership")
		}
	}
	for range 2 {
		w := serve(request(http.MethodPost, "", body))
		var ack map[string]any
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &ack) != nil || len(ack) != 6 ||
			ack["actorUID"] != seed.ActorUID || ack["writerEpoch"] != float64(2) || !saved.Imported || commits != 1 {
			t.Fatal("lost-ACK retry changed the first import or its owner")
		}
	}
	// Reload only the fixture receipt, not a native snapshot. A real cold
	// Parent still runs the unchanged production bootstrap/retained restore.
	var restored nativeMemorySourceReceipt
	if err := json.Unmarshal(persisted, &restored); err != nil || !restored.Imported {
		t.Fatal("first import receipt could not be retained:", err)
	}
	handler = nativeMemorySourceHandler(&restored, "owned-parent", file.Name(), func() error {
		t.Error("retained lease replayed the initial commit")
		return errors.New("retained commits are not needed")
	})
	if err := os.Remove(file.Name()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		w := serve(request(http.MethodGet, "", ""))
		var lease map[string]any
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &lease) != nil || len(lease) != 7 ||
			lease["version"] != float64(2) || lease["retained"] != true || lease["checkpoint"] != nil ||
			lease["actorUID"] != seed.ActorUID || lease["writerEpoch"] != float64(2) ||
			lease["changeWriterEpoch"] != float64(1) || lease["readOnly"] != false {
			t.Fatalf("retained lease changed its exact shape, Actor or epoch: %s", w.Body.String())
		}
		if w := serve(request(http.MethodGet, chunk, "")); w.Code != http.StatusConflict {
			t.Fatal("retained owner reopened the first seed archive")
		}
	}
	for _, header := range []string{"Authorization", "X-Factory-Runtime-Actor-UID", "X-Factory-Runtime-Generation", "X-Factory-Source-Protocol"} {
		r := request(http.MethodGet, "", "")
		r.Header.Set(header, "foreign")
		if w := serve(r); w.Code != http.StatusForbidden {
			t.Fatal("retained lease accepted foreign identity:", header)
		}
	}
	pending := nativeMemorySourceReceipt{Version: 1, AttemptID: saved.AttemptID, Seed: seed}
	handler = nativeMemorySourceHandler(&pending, "owned-parent", file.Name(), func() error {
		return errors.New("owned receipt persistence failure")
	})
	if w := serve(request(http.MethodPost, "", body)); w.Code != http.StatusServiceUnavailable || pending.Imported {
		t.Fatal("unpersisted first commit was presented as retained ownership")
	}
}

// An explicitly enabled native qualification peer, not Factory product
// authority. Production Parent/Work/Source run unchanged in their own containers.
// The peer retains its first seed/import receipt between cold boots. Only an
// external native runner can qualify MEMORY; observing Source is not RAM proof.
func TestNativeMemoryFactoryFixture(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_MEMORY_FIXTURE") != "1" {
		t.Skip("explicit native Source/MEMORY qualification only")
	}
	if os.Getpid() != 1 || os.Geteuid() != 1000 {
		t.Fatal("fixture requires its own non-root native container")
	}
	var input struct {
		AttemptID, WorkspaceID, Parent, Child, Observe string
		SeedID, CheckID                                string
		Entries                                        map[string]string
		Coding                                         bool
		ModelToken                                     string
		Variables                                      map[string]string
	}
	if json.Unmarshal([]byte(os.Getenv("FACTORY_NATIVE_MEMORY_INPUT")), &input) != nil ||
		!sourceRestoreUUID.MatchString(input.SeedID) || !sourceRestoreUUID.MatchString(input.CheckID) ||
		input.AttemptID == "" || !sourceRestoreUUID.MatchString(input.WorkspaceID) || input.Parent == "" || input.Observe == "" {
		t.Fatal("invalid fixed native qualification identity")
	}
	os.Unsetenv("FACTORY_NATIVE_MEMORY_INPUT")
	if len(input.Variables) > 8 {
		t.Fatal("owned native fixture environment exceeds its bound")
	}
	for name, value := range input.Variables {
		if !nativeProjectVariable(name) || len(value) > 32768 || strings.ContainsRune(value, 0) {
			t.Fatal("owned native fixture environment is invalid")
		}
	}
	identity, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil {
		t.Fatal(err)
	}
	actorUID := strings.TrimSpace(string(identity))
	const archive = "/fixture-state/source.tar"
	const receipt = "/fixture-state/receipt.json"
	var saved nativeMemorySourceReceipt
	persist := func() error {
		data, err := json.Marshal(saved)
		if err != nil {
			return err
		}
		if err := os.WriteFile(receipt+".tmp", data, 0600); err != nil {
			return err
		}
		return os.Rename(receipt+".tmp", receipt)
	}
	data, err := os.ReadFile(receipt)
	if errors.Is(err, os.ErrNotExist) {
		source, err := workspacefiles.Open("/fixture/seed")
		if err != nil {
			t.Fatal(err)
		}
		file, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		bundle, err := source.ExportBundle(file)
		source.Close()
		if err == nil {
			err = file.Sync()
		}
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		saved.Version, saved.AttemptID = 1, input.AttemptID
		saved.Seed = sourceRestoreResponse{Version: 2, ActorUID: actorUID,
			WriterEpoch: 2, ChangeWriterEpoch: 1, CheckpointSeedID: &input.SeedID,
			Checkpoint: &sourceRestoreCheckpoint{ID: input.SeedID, WorkspaceID: input.WorkspaceID,
				SeedID: &input.SeedID, WriterEpoch: 1, Generation: 1, Bundle: bundle}}
		if err := persist(); err != nil {
			t.Fatal(err)
		}
	} else {
		d := json.NewDecoder(strings.NewReader(string(data)))
		d.DisallowUnknownFields()
		if err != nil || len(data) > 1<<20 || d.Decode(&saved) != nil || d.Decode(new(any)) != io.EOF ||
			saved.Version != 1 || saved.AttemptID != input.AttemptID ||
			validateSourceRestoreLease(saved.Seed, input.WorkspaceID, actorUID, 1) != nil ||
			saved.Seed.WriterEpoch != 2 || saved.Seed.ChangeWriterEpoch != 1 || saved.Seed.ReadOnly ||
			saved.Seed.Checkpoint.ID != input.SeedID || saved.Seed.CheckpointSeedID == nil ||
			*saved.Seed.CheckpointSeedID != input.SeedID || saved.Seed.Checkpoint.Generation != 1 {
			t.Fatal("retained native fixture Source identity changed; historical receipts are not reusable")
		}
	}
	type peer struct {
		conn *websocket.Conn
		send sync.Mutex
	}
	var mutex sync.Mutex
	peers := map[string]*peer{}
	pending := map[string]chan Message{}
	var sourceEpoch uint64
	var sourceReadyAt, childReadyAt int64
	modelRequests := saved.ModelRequests
	childReady := false
	processes := map[string]Message{}
	entryGrants := map[string]int64{}
	route := func(message Message) string {
		if message.OperationID != "" {
			return message.OperationID
		}
		return message.StreamID
	}
	call := func(ctx context.Context, role string, message Message) ([]Message, error) {
		key := route(message)
		channel := make(chan Message, 128)
		mutex.Lock()
		target := peers[role]
		if target == nil || pending[key] != nil {
			mutex.Unlock()
			return nil, errors.New("native qualification peer/operation unavailable")
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
				if response.Error != "" {
					return nil, errors.New(response.Error)
				}
				if response.Type == "operation-response" || response.Type == "stream-end" || response.Type == "stream-error" {
					return messages, nil
				}
			}
		}
	}
	sourceCall := func(ctx context.Context, operation string, body any) ([]byte, error) {
		bodyBytes, _ := json.Marshal(body)
		messages, err := call(ctx, "parent", Message{Type: "http-request", StreamID: fmt.Sprintf("source-%d", time.Now().UnixNano()),
			Channel: "source", Method: "POST", Path: "/v1/workspaces/" + input.WorkspaceID + "/" + operation,
			Headers: map[string]string{"x-factory-writer-epoch": "1"}, Data: base64.StdEncoding.EncodeToString(bodyBytes)})
		if err != nil {
			return nil, err
		}
		var result []byte
		for _, message := range messages {
			if message.Type == "http-response" && message.Status != 200 {
				return nil, fmt.Errorf("native Source %s HTTP %d", operation, message.Status)
			}
			if message.Type == "stream-data" {
				part, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					return nil, err
				}
				result = append(result, part...)
			}
		}
		return result, nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/proof/agent/", func(w http.ResponseWriter, r *http.Request) {
		if !input.Coding || r.Header.Get("Authorization") != "Bearer "+input.Observe {
			w.WriteHeader(403)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/proof/agent")
		if !strings.HasPrefix(path, "/api/") {
			w.WriteHeader(404)
			return
		}
		if r.URL.RawQuery != "" {
			path += "?" + r.URL.RawQuery
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxMessageBytes+1))
		if err != nil || len(body) > maxMessageBytes {
			w.WriteHeader(400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		messages, err := call(ctx, "child", Message{Type: "http-request",
			StreamID: fmt.Sprintf("agent-%d", time.Now().UnixNano()), Channel: "agent", Method: r.Method,
			Path: path, Headers: map[string]string{"content-type": r.Header.Get("Content-Type")},
			Data: base64.StdEncoding.EncodeToString(body)})
		if err != nil {
			http.Error(w, err.Error(), 503)
			return
		}
		for _, message := range messages {
			if message.Type == "http-response" {
				for key, value := range message.Headers {
					w.Header().Set(key, value)
				}
				w.WriteHeader(message.Status)
			}
			if message.Type == "stream-data" {
				part, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					return
				}
				w.Write(part)
			}
		}
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if !input.Coding || input.ModelToken == "" || r.Method != "POST" ||
			r.Header.Get("Authorization") != "Bearer "+input.ModelToken {
			w.WriteHeader(403)
			return
		}
		var request struct {
			Model string `json:"model"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&request) != nil {
			w.WriteHeader(400)
			return
		}
		mutex.Lock()
		modelRequests++
		call := modelRequests
		saved.ModelRequests = modelRequests
		persistErr := persist()
		mutex.Unlock()
		if persistErr != nil {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		deltas := []map[string]any{{"content": "Owned native Actor Coding done"}, {}}
		if call == 1 {
			arguments, _ := json.Marshal(map[string]string{
				"command": "test ! -w /run/factory-skills && test ! -w /run/factory-skills/admitted && " +
					"test ! -w /run/factory-skills/admitted/factory-" + input.SeedID + "/SKILL.md && " +
					"printf 'native Actor Coding executed once\\n' >> actor-change.txt",
				"description": "Owned actual native Actor tool execution",
			})
			deltas = []map[string]any{{"tool_calls": []any{map[string]any{
				"index": 0, "id": "call_owned_native_actor", "type": "function",
				"function": map[string]string{"name": "shell", "arguments": string(arguments)},
			}}}}
		}
		for _, delta := range deltas {
			finish := any(nil)
			if call == 1 {
				finish = "tool_calls"
			} else if len(delta) == 0 {
				finish = "stop"
			}
			data, _ := json.Marshal(map[string]any{"id": "chatcmpl_owned_actor",
				"object": "chat.completion.chunk", "created": 1, "model": request.Model,
				"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
			fmt.Fprintf(w, "data: %s\n\n", data)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	mux.HandleFunc("/internal/runtime-connect", func(w http.ResponseWriter, r *http.Request) {
		role := r.Header.Get("X-Factory-Connector-Role")
		expected := map[string]string{"parent": input.Parent, "child": input.Child}[role]
		if expected == "" || r.Header.Get("Authorization") != "Bearer "+expected ||
			r.Header.Get("X-Factory-Runtime-Attempt") != input.AttemptID ||
			r.Header.Get("X-Factory-Runtime-Generation") != "1" ||
			r.Header.Get("X-Factory-Runtime-Actor-UID") != actorUID {
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
		if role == "parent" {
			sourceEpoch = 0
		} else {
			childReady = false
		}
		mutex.Unlock()
		defer func() {
			mutex.Lock()
			if peers[role] == current {
				delete(peers, role)
				if role == "parent" {
					sourceEpoch = 0
				} else {
					childReady = false
				}
			}
			mutex.Unlock()
		}()
		for {
			var message Message
			if conn.ReadJSON(&message) != nil {
				return
			}
			mutex.Lock()
			if message.Type == "hello" {
				bound := message.Role == role && message.AttemptID == input.AttemptID && message.Generation == 1
				if role == "parent" {
					sourceEpoch = 0
					if bound && saved.Imported && message.SourceEpoch != nil && *message.SourceEpoch == saved.Seed.WriterEpoch {
						for _, channel := range message.Channels {
							if channel.Name == "source" && channel.Kind == "source" {
								sourceEpoch = *message.SourceEpoch
							}
						}
					}
					if sourceEpoch != 0 && sourceReadyAt == 0 {
						sourceReadyAt = time.Now().UnixNano()
					}
				} else {
					childReady = bound
					if bound {
						childReadyAt = time.Now().UnixNano()
					}
				}
			}
			if role == "child" && message.Type == "process-state" {
				processes[message.Process] = message
			}
			response := pending[route(message)]
			mutex.Unlock()
			if response != nil {
				select {
				case response <- message:
				default:
					t.Error("native qualification response bound exceeded")
				}
			}
		}
	})
	sourceLease := nativeMemorySourceHandler(&saved, input.Parent, archive, persist)
	mux.HandleFunc("/internal/substrate-source/"+input.AttemptID, func(w http.ResponseWriter, r *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		sourceLease(w, r)
	})
	mux.HandleFunc("/internal/runtime-environment/"+input.AttemptID, func(w http.ResponseWriter, r *http.Request) {
		name := r.Header.Get("X-Factory-Runtime-Container")
		if input.Entries[name] == "" || r.Header.Get("Authorization") != "Bearer "+input.Entries[name] ||
			r.Header.Get("X-Factory-Runtime-Actor-UID") != actorUID {
			w.WriteHeader(403)
			return
		}
		mutex.Lock()
		ready := saved.Imported && sourceEpoch == saved.Seed.WriterEpoch
		if ready {
			entryGrants[name] = time.Now().UnixNano()
		}
		mutex.Unlock()
		if !ready {
			w.WriteHeader(409)
			return
		}
		variables := []environmentVariable{
			{Name: "POSTGRES_PASSWORD", Value: "owned-native-database", Runtime: true},
			{Name: "PROOF_RUNTIME_NONCE", Value: "runtime-only-entry", Runtime: true},
		}
		for name, value := range input.Variables {
			replaced := false
			for index := range variables {
				if variables[index].Name == name {
					variables[index].Value = value
					replaced = true
				}
			}
			if !replaced {
				variables = append(variables, environmentVariable{Name: name, Value: value, Runtime: true})
			}
		}
		json.NewEncoder(w).Encode(runtimeEnvironment{Version: 0, Bundle: environmentBundle{Variables: variables}})
	})
	mux.HandleFunc("/proof/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+input.Observe {
			w.WriteHeader(401)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		switch r.URL.Path {
		case "/proof/state":
			mutex.Lock()
			defer mutex.Unlock()
			imports := 0
			if saved.Imported {
				imports = 1
			}
			json.NewEncoder(w).Encode(map[string]any{"sourceEpoch": sourceEpoch, "childReady": childReady,
				"actorUID": actorUID, "writerEpoch": saved.Seed.WriterEpoch, "retained": saved.Imported,
				"seedID": input.SeedID, "seedImports": imports,
				"modelRequests": modelRequests, "sourceReadyAt": sourceReadyAt, "childReadyAt": childReadyAt,
				"entryGrants": entryGrants, "processes": processes})
		case "/proof/tree":
			data, err := sourceCall(ctx, "list", map[string]any{"path": ""})
			if err != nil {
				http.Error(w, err.Error(), 503)
				return
			}
			mutex.Lock()
			currentEpoch, currentChild := sourceEpoch, childReady
			mutex.Unlock()
			json.NewEncoder(w).Encode(map[string]any{"listing": json.RawMessage(data),
				"sourceEpoch": currentEpoch, "childReady": currentChild})
		case "/proof/check":
			action := "command-read"
			var data []byte
			if r.Method == http.MethodPost {
				action = "command-start"
				digest := sha256.Sum256([]byte("native-starter-check-v1:npm run check"))
				data, _ = json.Marshal(CommandRequest{ID: input.CheckID,
					Digest: hex.EncodeToString(digest[:]), Command: "npm run check"})
				// One explicit finite command, not a supervised App or a retry.
				// A lost dispatch reply is observed through GET, never reissued.
				file, err := os.OpenFile("/fixture-state/check-intent.json", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err != nil {
					http.Error(w, "owned check already dispatched; observe its original identity", 409)
					return
				}
				_, written := file.Write(data)
				if written == nil {
					written = file.Sync()
				}
				closed := file.Close()
				if written != nil || closed != nil {
					http.Error(w, "owned check intent is unconfirmed", 503)
					return
				}
			} else if r.Method == http.MethodGet {
				data, _ = json.Marshal(CommandRead{ID: input.CheckID})
			} else {
				w.WriteHeader(405)
				return
			}
			result, err := call(ctx, "child", Message{Type: "operation-request",
				OperationID: fmt.Sprintf("starter-check-%d", time.Now().UnixNano()), Action: action,
				AttemptID: input.AttemptID, Generation: 1, Data: string(data)})
			if err != nil || len(result) != 1 || result[0].Data == "" {
				http.Error(w, "owned check operation unconfirmed", 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(result[0].Data))
		case "/proof/skills":
			if !input.Coding || r.Method != "POST" {
				w.WriteHeader(403)
				return
			}
			body := []byte("---\nname: owned-native-guidance\ndescription: Owned native immutable guidance\n---\nRetain the human draft and execute only the admitted task.\n")
			digest := sha256.Sum256(body)
			files := []struct {
				Path       string `json:"path"`
				Body       string `json:"body"`
				Digest     string `json:"digest"`
				Executable bool   `json:"executable"`
			}{{"factory-" + input.SeedID + "/SKILL.md", base64.StdEncoding.EncodeToString(body), hex.EncodeToString(digest[:]), false}}
			canonical, _ := json.Marshal(files)
			manifestDigest := sha256.Sum256(canonical)
			manifest, _ := json.Marshal(map[string]any{"files": files, "digest": hex.EncodeToString(manifestDigest[:])})
			_, err := call(ctx, "parent", Message{Type: "operation-request", OperationID: "skills-" + input.SeedID,
				Action: "skills-install", Data: string(manifest)})
			if err != nil {
				http.Error(w, err.Error(), 503)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"confirmed": true, "skillID": "factory-" + input.SeedID})
		case "/proof/retained-source":
			if r.Method != http.MethodGet {
				w.WriteHeader(405)
				return
			}
			mutex.Lock()
			original := peers["parent"]
			current := saved.Imported && original != nil && sourceEpoch == saved.Seed.WriterEpoch
			mutex.Unlock()
			if !current {
				http.Error(w, "original Source owner is not connected/current", http.StatusServiceUnavailable)
				return
			}
			// A real read through production Parent/Source, not a renewed
			// writer grant, checkpoint export or claim of MEMORY continuity.
			if _, err := sourceCall(ctx, "stat", map[string]any{"path": ""}); err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			mutex.Lock()
			current = peers["parent"] == original && sourceEpoch == saved.Seed.WriterEpoch
			mutex.Unlock()
			if !current {
				http.Error(w, "Source connection changed during observation", http.StatusServiceUnavailable)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"sourceCurrent": true, "actorUID": actorUID,
				"writerEpoch": saved.Seed.WriterEpoch, "changeWriterEpoch": saved.Seed.ChangeWriterEpoch, "seedImports": 1})
		default:
			w.WriteHeader(404)
		}
	})
	lifetime, cancel := signal.NotifyContext(t.Context(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	ctx, stop := context.WithTimeout(lifetime, 12*time.Minute)
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
		t.Fatal("owned native Source/MEMORY fixture lifetime expired")
	}
}
