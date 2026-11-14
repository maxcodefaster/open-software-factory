package connector

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func TestSubstrateSourceRestoreBindsCurrentActorAndCheckpointProvenance(t *testing.T) {
	const workspaceID = "11345112-f121-4739-b2f3-6c6cf60bd2bf"
	const actorUID = "526dbdeb-6396-42c2-a0ab-6a69f5173b36"
	const predecessorUID = "9e6d84df-2a59-41e8-b5bc-1711af5bcc3e"
	original := sourceRestoreResponse{
		ActorUID: actorUID, CheckpointActorUID: predecessorUID,
		WriterEpoch: 5, ChangeWriterEpoch: 42,
		Checkpoint: &sourceRestoreCheckpoint{
			ID:          "375460ae-0b12-4efb-98b0-5ce0ca928a8d",
			WorkspaceID: workspaceID, ActorUID: predecessorUID,
			WriterEpoch: 4, Generation: 2,
			Bundle: workspacefiles.Bundle{
				Version: 1, Bytes: 8, SHA256: strings.Repeat("a", 64),
				Chunks: []string{strings.Repeat("a", 64)},
			},
		},
	}
	if err := validateSourceRestoreLease(original, workspaceID, actorUID); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(*sourceRestoreResponse){
		func(r *sourceRestoreResponse) { r.ActorUID = predecessorUID },
		func(r *sourceRestoreResponse) { r.CheckpointActorUID = actorUID },
		func(r *sourceRestoreResponse) { r.Checkpoint.ActorUID = actorUID },
		func(r *sourceRestoreResponse) { r.Checkpoint.WorkspaceID = actorUID },
		func(r *sourceRestoreResponse) { r.Checkpoint.WriterEpoch = r.WriterEpoch },
		func(r *sourceRestoreResponse) { r.Checkpoint.Generation = 0 },
		func(r *sourceRestoreResponse) { r.Checkpoint.Bundle.Bytes = 0 },
		func(r *sourceRestoreResponse) { r.Checkpoint.Bundle.Chunks = nil },
	} {
		bytes, err := json.Marshal(original)
		if err != nil {
			t.Fatal(err)
		}
		var changed sourceRestoreResponse
		if err := json.Unmarshal(bytes, &changed); err != nil {
			t.Fatal(err)
		}
		mutation(&changed)
		if err := validateSourceRestoreLease(changed, workspaceID, actorUID); err == nil {
			t.Fatalf("foreign/incomplete Source lease was accepted: %+v", changed)
		}
	}
	fresh := sourceRestoreResponse{ActorUID: actorUID, WriterEpoch: 1, ChangeWriterEpoch: 1}
	if err := validateSourceRestoreLease(fresh, workspaceID, actorUID); err != nil {
		t.Fatal(err)
	}
	fresh.CheckpointActorUID = predecessorUID
	if err := validateSourceRestoreLease(fresh, workspaceID, actorUID); err == nil {
		t.Fatal("fresh Source accepted an unbound checkpoint producer")
	}
	changed := original
	copy := *original.Checkpoint
	changed.Checkpoint = &copy
	changed.Checkpoint.Bundle.SHA256 = strings.Repeat("b", 64)
	if sameSourceRestoreLease(changed, original) {
		t.Fatal("publication check did not detect changed checkpoint bytes under the same ID")
	}
}

func TestInputStopSourceRestoreRequiresReadOnlyOriginalCheckpoint(t *testing.T) {
	input := ownedInputStop()
	const workspaceID = "11345112-f121-4739-b2f3-6c6cf60bd2bf"
	const actorUID = "526dbdeb-6396-42c2-a0ab-6a69f5173b36"
	original := sourceRestoreResponse{ActorUID: actorUID, CheckpointActorUID: actorUID, WriterEpoch: 5, ChangeWriterEpoch: 42,
		ReadOnly: true, InputStop: &input, Checkpoint: &sourceRestoreCheckpoint{ID: input.StopID, WorkspaceID: workspaceID,
			ActorUID: actorUID, WriterEpoch: 4, Generation: 2, Bundle: workspacefiles.Bundle{
				Version: 1, Bytes: 4, SHA256: strings.Repeat("a", 64), Chunks: []string{strings.Repeat("a", 64)}}}}
	if err := validateSourceRestoreLease(original, workspaceID, actorUID); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*sourceRestoreResponse){
		func(r *sourceRestoreResponse) { r.ReadOnly = false },
		func(r *sourceRestoreResponse) { r.Checkpoint = nil },
		func(r *sourceRestoreResponse) { r.InputStop.Mode = "observe" },
		func(r *sourceRestoreResponse) { r.InputStop.SessionID = "unbound" },
		func(r *sourceRestoreResponse) {
			r.CheckpointActorUID = input.StopID
			r.Checkpoint.ActorUID = input.StopID
		},
	} {
		data, _ := json.Marshal(original)
		var changed sourceRestoreResponse
		if err := json.Unmarshal(data, &changed); err != nil {
			t.Fatal(err)
		}
		mutate(&changed)
		if validateSourceRestoreLease(changed, workspaceID, actorUID) == nil {
			t.Fatal("unbound/writable Stop Source restore was accepted")
		}
	}
}

func TestSubstrateSourceRestoreRetriesOnlyExactCheckpointReads(t *testing.T) {
	for _, failure := range []string{"gateway", "truncated-body"} {
		t.Run(failure, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.RawQuery != "chunk=7&checkpoint=owned" || r.Header.Get("Authorization") != "Bearer owned-parent" || r.Header.Get("X-Factory-Source-Writer-Epoch") != "5" {
					t.Error("Source read identity changed during transport recovery")
					w.WriteHeader(http.StatusForbidden)
					return
				}
				if calls.Add(1) == 1 {
					if failure == "gateway" {
						w.WriteHeader(http.StatusBadGateway)
					} else {
						w.Header().Set("Content-Length", "100")
						io.WriteString(w, "incomplete")
					}
					return
				}
				io.WriteString(w, "exact checkpoint chunk")
			}))
			defer server.Close()
			request, err := http.NewRequest(http.MethodGet, server.URL+"?chunk=7&checkpoint=owned", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer owned-parent")
			request.Header.Set("X-Factory-Source-Writer-Epoch", "5")
			body, err := readSubstrateSourceRestore(t.Context(), server.Client(), request)
			if err != nil || string(body) != "exact checkpoint chunk" || calls.Load() != 2 {
				t.Fatalf("read recovery: body=%q calls=%d err=%v", body, calls.Load(), err)
			}
		})
	}
}

func TestSubstrateSourceRestoreDoesNotRetryAuthorityOrBounds(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict, http.StatusOK} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(status)
				if status == http.StatusOK {
					io.WriteString(w, strings.Repeat("x", workspacefiles.SourceChunkBytes+1))
				}
			}))
			defer server.Close()
			request, err := http.NewRequest(http.MethodGet, server.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := readSubstrateSourceRestore(t.Context(), server.Client(), request); err == nil || calls.Load() != 1 {
				t.Fatalf("permanent refusal retried: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestSubstrateSourceRestoreCancellationStopsTransientReads(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		cancel()
	}))
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readSubstrateSourceRestore(ctx, server.Client(), request); !errors.Is(err, context.Canceled) || calls.Load() != 1 {
		t.Fatalf("cancellation did not stop the original read: calls=%d err=%v", calls.Load(), err)
	}
}

func TestSubstrateSourceRestoreNeverRetriesInvalidServingIdentity(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("wrong-host request reached the HTTP handler")
	}))
	defer server.Close()
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	client := server.Client()
	transport := client.Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: transport.TLSClientConfig.RootCAs, ServerName: "wrong.invalid", MinVersion: tls.VersionTLS12}
	client.Transport = transport
	defer transport.CloseIdleConnections()
	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readSubstrateSourceRestore(t.Context(), client, request); err == nil || err.Error() != "Source restore serving identity is invalid" {
		t.Fatalf("invalid TLS serving identity was not refused: %v", err)
	}
}
