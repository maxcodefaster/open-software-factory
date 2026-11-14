package connector

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestInputStopSourceOnlyParentKeepsItsResultReadableAfterDrainAndReconnect(t *testing.T) {
	assignment := validAssignment()
	input := ownedInputStop()
	result := nativeInputStopResult{nativeInputStopWorkerResult: nativeInputStopWorkerResult{nativeInputStop: input, Confirmed: true, EngineExited: true}, ProcessTreeExited: true}
	workspace := "owned-workspace"
	var exports, connections atomic.Int32
	assignment.nativeSource = inputStopSourceHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exports.Add(1)
		_, _ = io.WriteString(w, "owned-checkpoint")
	}), workspace)
	observed := make(chan error, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		index := connections.Add(1)
		check := func() error {
			var hello Message
			if err := connection.ReadJSON(&hello); err != nil {
				return err
			}
			if hello.Type != "hello" || hello.Role != "parent" || len(hello.Channels) != 1 || hello.Channels[0].Name != "source" {
				return io.ErrUnexpectedEOF
			}
			request := func(message Message) (Message, error) {
				if err := connection.WriteJSON(message); err != nil {
					return Message{}, err
				}
				var response Message
				err := connection.ReadJSON(&response)
				return response, err
			}
			for _, action := range []string{"workspace-git", "skills-install", "browser-open"} {
				reply, err := request(Message{Type: "operation-request", Action: action, OperationID: action})
				if err != nil || reply.Error == "" {
					return io.ErrUnexpectedEOF
				}
			}
			if index == 1 {
				_ = connection.WriteJSON(Message{Type: "http-request", Channel: "source", StreamID: "forbidden-read", Method: "POST", Path: "/v1/workspaces/" + workspace + "/read"})
				var first Message
				if err := connection.ReadJSON(&first); err != nil || first.Status != http.StatusForbidden {
					return io.ErrUnexpectedEOF
				}
				for first.Type != "stream-end" {
					if err := connection.ReadJSON(&first); err != nil {
						return err
					}
				}
				drained, err := request(Message{Type: "operation-request", Action: "source-drain", OperationID: "checkpoint-original"})
				if err != nil || drained.Error != "" {
					return io.ErrUnexpectedEOF
				}
			} else {
				refused, err := request(Message{Type: "operation-request", Action: "source-drain", OperationID: "checkpoint-different"})
				if err != nil || refused.Error == "" {
					return io.ErrUnexpectedEOF
				}
			}
			reply, err := request(Message{Type: "operation-request", Action: "input-stop-result", OperationID: input.StopID})
			if err != nil || reply.Error != "" {
				return io.ErrUnexpectedEOF
			}
			var saved nativeInputStopResult
			if json.Unmarshal([]byte(reply.Data), &saved) != nil || saved != result {
				return io.ErrUnexpectedEOF
			}
			return nil
		}
		if err := check(); err != nil {
			observed <- err
			return
		}
		if index == 1 {
			return
		}
		observed <- nil
		_, _, _ = connection.ReadMessage()
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- serveInputStopParent(ctx, assignment, "owned-parent-capability", &result, input.StopID)
	}()
	select {
	case err := <-observed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("owned input Stop transport timed out")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Source-only Parent did not join")
	}
	if exports.Load() != 0 || connections.Load() != 2 {
		t.Fatal("Source-only Parent replayed work or exposed checkout operations")
	}
}

func TestNativeInputStopRecordRetainsExactAdmissionAndJoinedOutcome(t *testing.T) {
	assignment := validAssignment()
	assignment.ConnectorStateDir = t.TempDir()
	input := ownedInputStop()
	source := sourceRestored{AttemptID: input.AttemptID, Generation: 1, ActorUID: input.StopID, WriterEpoch: 3, ChangeWriterEpoch: 42, ReadOnly: true, InputStop: &input}
	result := nativeInputStopResult{nativeInputStopWorkerResult: nativeInputStopWorkerResult{nativeInputStop: input, Confirmed: true, EngineExited: true}, ProcessTreeExited: true}
	path := filepath.Join(assignment.ConnectorStateDir, "input-stop-"+input.StopID+".json")
	record := nativeInputStopRecord{Source: source, Result: &result}
	if err := syncInputStopRecord(path, record, true); err != nil {
		t.Fatal(err)
	}
	if err := syncInputStopRecord(path, record, true); !os.IsExist(err) {
		t.Fatal("existing start record was overwritten", err)
	}
	saved, err := executeRecordedInputStop(t.Context(), bootstrap{Assignment: assignment}, source)
	if err != nil || saved == nil || *saved != result {
		t.Fatal("joined outcome was not reused", err)
	}
	foreign := source
	foreign.WriterEpoch++
	if _, err := executeRecordedInputStop(t.Context(), bootstrap{Assignment: assignment}, foreign); err == nil {
		t.Fatal("saved outcome retargeted to another Source lease")
	}
}

func TestColdModeRequiresThisAttemptGenerationActorAndReadOnlyStopAdmission(t *testing.T) {
	input := ownedInputStop()
	assignment := validAssignment()
	assignment.RuntimeAttemptID = input.AttemptID
	assignment.ConnectorStateDir = t.TempDir()
	b := bootstrap{Assignment: assignment, SourceHandoff: true}
	if err := json.Unmarshal([]byte(`{"version":1,"openCodeVersion":"2.0.27"}`), &b.InputStop); err != nil {
		t.Fatal(err)
	}
	source := sourceRestored{AttemptID: input.AttemptID, Generation: assignment.Generation, ActorUID: input.StopID,
		WriterEpoch: 3, ChangeWriterEpoch: 42, ReadOnly: true, InputStop: &input}
	save := func(value sourceRestored) {
		t.Helper()
		data, _ := json.Marshal(value)
		if err := os.WriteFile(filepath.Join(assignment.ConnectorStateDir, "source-restored.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	save(source)
	if _, err := readNativeRestored(b, source.ActorUID); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*sourceRestored){
		func(r *sourceRestored) { r.AttemptID = input.StopID },
		func(r *sourceRestored) { r.Generation++ },
		func(r *sourceRestored) { r.ActorUID = input.AttemptID },
		func(r *sourceRestored) { r.ReadOnly = false },
		func(r *sourceRestored) { r.WriterEpoch = 0 },
	} {
		copy := source
		mutate(&copy)
		save(copy)
		if _, err := readNativeRestored(b, source.ActorUID); err == nil {
			t.Fatal("foreign/stale/writable cold mode was accepted")
		}
	}
	save(source)
	b.InputStop.Version = 2
	if _, err := readNativeRestored(b, source.ActorUID); err == nil {
		t.Fatal("unadmitted bootstrap capability accepted")
	}
}
