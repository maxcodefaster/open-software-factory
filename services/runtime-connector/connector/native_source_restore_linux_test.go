package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/iotest"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func TestSubstrateSourceRestoreV2LeaseRequirements(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"missing-version":    func(w map[string]any) { delete(w, "version") },
		"null-version":       func(w map[string]any) { w["version"] = nil },
		"old-version":        func(w map[string]any) { w["version"] = 1 },
		"future-version":     func(w map[string]any) { w["version"] = 3 },
		"missing-checkpoint": func(w map[string]any) { delete(w, "checkpoint"); w["checkpointSeedID"] = nil },
		"null-checkpoint":    func(w map[string]any) { w["checkpoint"], w["checkpointSeedID"] = nil, nil },
		"skipped-epoch":      func(w map[string]any) { w["writerEpoch"] = 3 },
	} {
		t.Run(name, func(t *testing.T) {
			wire := sourceSeedRestoreJSON()
			wire["version"] = 2
			mutate(wire)
			reply := decodeSourceRestoreTest(t, wire)
			if err := validateSourceRestoreLease(reply, "11345112-f121-4739-b2f3-6c6cf60bd2bf", reply.ActorUID, 1); err == nil {
				t.Fatal("Source restore accepted a lease without the v2 checkpoint/next-owner contract")
			}
		})
	}
}

func sourceRestoreV2TestLease(t *testing.T) sourceRestoreResponse {
	t.Helper()
	wire := sourceSeedRestoreJSON()
	wire["version"] = 2
	return decodeSourceRestoreTest(t, wire)
}

func TestSubstrateSourceRestoreV2SeedSuccessorsAndProvenance(t *testing.T) {
	reply := sourceRestoreV2TestLease(t)
	for _, generation := range []uint64{1, 2, 100} {
		if err := validateSourceRestoreLease(reply, reply.Checkpoint.WorkspaceID, reply.ActorUID, generation); err != nil {
			t.Fatalf("never-granted seed successor generation %d: %v", generation, err)
		}
	}
	for name, mutate := range map[string]func(*sourceRestoreResponse){
		"recipient":        func(r *sourceRestoreResponse) { r.ActorUID = r.Checkpoint.ID },
		"actor-producer":   func(r *sourceRestoreResponse) { r.CheckpointActorUID = r.ActorUID },
		"actor-and-seed":   func(r *sourceRestoreResponse) { r.Checkpoint.ActorUID = r.ActorUID },
		"missing-seed":     func(r *sourceRestoreResponse) { r.Checkpoint.SeedID = nil },
		"missing-binding":  func(r *sourceRestoreResponse) { r.CheckpointSeedID = nil },
		"different-seed":   func(r *sourceRestoreResponse) { id := r.Checkpoint.ID; r.CheckpointSeedID = &id },
		"malformed-seed":   func(r *sourceRestoreResponse) { id := "invalid"; r.Checkpoint.SeedID, r.CheckpointSeedID = &id, &id },
		"wrong-workspace":  func(r *sourceRestoreResponse) { r.Checkpoint.WorkspaceID = r.ActorUID },
		"unconfirmed":      func(r *sourceRestoreResponse) { r.Checkpoint = nil },
		"input-stop-seed":  func(r *sourceRestoreResponse) { stop := ownedInputStop(); r.ReadOnly, r.InputStop = true, &stop },
		"overflowed-epoch": func(r *sourceRestoreResponse) { r.WriterEpoch, r.Checkpoint.WriterEpoch = 0, ^uint64(0) },
	} {
		t.Run(name, func(t *testing.T) {
			reply := sourceRestoreV2TestLease(t)
			mutate(&reply)
			if err := validateSourceRestoreLease(reply, "11345112-f121-4739-b2f3-6c6cf60bd2bf", "526dbdeb-6396-42c2-a0ab-6a69f5173b36", 2); err == nil {
				t.Fatal("seed successor accepted foreign or incomplete provenance")
			}
		})
	}
}

func TestSubstrateSourceRestoreBindsCurrentActorAndCheckpointProvenance(t *testing.T) {
	const workspaceID = "11345112-f121-4739-b2f3-6c6cf60bd2bf"
	const actorUID = "526dbdeb-6396-42c2-a0ab-6a69f5173b36"
	const predecessorUID = "9e6d84df-2a59-41e8-b5bc-1711af5bcc3e"
	original := sourceRestoreResponse{
		Version: 2, ActorUID: actorUID, CheckpointActorUID: predecessorUID,
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
	if err := validateSourceRestoreLease(original, workspaceID, actorUID, 3); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(*sourceRestoreResponse){
		func(r *sourceRestoreResponse) { r.ActorUID = predecessorUID },
		func(r *sourceRestoreResponse) { r.CheckpointActorUID = actorUID },
		func(r *sourceRestoreResponse) { r.Checkpoint.ActorUID = actorUID },
		func(r *sourceRestoreResponse) { r.Checkpoint.WorkspaceID = actorUID },
		func(r *sourceRestoreResponse) { r.Checkpoint.WriterEpoch = r.WriterEpoch },
		func(r *sourceRestoreResponse) { r.Checkpoint.WriterEpoch = r.WriterEpoch - 2 },
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
		if err := validateSourceRestoreLease(changed, workspaceID, actorUID, 3); err == nil {
			t.Fatalf("foreign/incomplete Source lease was accepted: %+v", changed)
		}
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
	original := sourceRestoreResponse{Version: 2, ActorUID: actorUID, CheckpointActorUID: actorUID, WriterEpoch: 5, ChangeWriterEpoch: 42,
		ReadOnly: true, InputStop: &input, Checkpoint: &sourceRestoreCheckpoint{ID: input.StopID, WorkspaceID: workspaceID,
			ActorUID: actorUID, WriterEpoch: 4, Generation: 2, Bundle: workspacefiles.Bundle{
				Version: 1, Bytes: 4, SHA256: strings.Repeat("a", 64), Chunks: []string{strings.Repeat("a", 64)}}}}
	if err := validateSourceRestoreLease(original, workspaceID, actorUID, 2); err != nil {
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
		if validateSourceRestoreLease(changed, workspaceID, actorUID, 2) == nil {
			t.Fatal("unbound/writable Stop Source restore was accepted")
		}
	}
}

func TestSubstrateSourceRestoreRetriesOnlyExactCheckpointReads(t *testing.T) {
	for _, failure := range []string{"gateway", "truncated-body"} {
		t.Run(failure, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.RawQuery != "chunk=7&checkpoint=owned" || r.Header.Get("Authorization") != "Bearer owned-parent" || r.Header.Get("X-Factory-Source-Writer-Epoch") != "5" || r.Header.Get("X-Factory-Source-Protocol") != "2" {
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
			request.Header.Set("X-Factory-Source-Protocol", "2")
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
	reply := sourceRestoreV2TestLease(t)
	err = commitSubstrateSourceRestore(t.Context(), client, sourceRestoreCommitTestRequest(t, server.URL, reply), &reply)
	if err == nil || err.Error() != "Source restore commit serving identity is invalid" {
		t.Fatalf("invalid TLS commit identity not refused: %v", err)
	}
}

func sourceRestoreCommitTestRequest(t *testing.T, endpoint string, reply sourceRestoreResponse) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer owned-parent")
	request.Header.Set("X-Factory-Runtime-Actor-UID", reply.ActorUID)
	request.Header.Set("X-Factory-Runtime-Generation", "2")
	request.Header.Set("X-Factory-Source-Protocol", "2")
	return request
}

func sourceRestoreCommitTestACK(reply sourceRestoreResponse) map[string]any {
	return map[string]any{"version": 2, "actorUID": reply.ActorUID, "checkpointID": reply.Checkpoint.ID,
		"writerEpoch": reply.WriterEpoch, "changeWriterEpoch": reply.ChangeWriterEpoch, "readOnly": reply.ReadOnly}
}

type sourceRestoreTestTransport func(*http.Request) (*http.Response, error)

func (transport sourceRestoreTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestSubstrateSourceRestoreCommitDoesNotRetryTLSBodyOrTransportRefusal(t *testing.T) {
	reply := sourceRestoreV2TestLease(t)
	for _, bodyFailure := range []bool{false, true} {
		var calls atomic.Int32
		client := &http.Client{Transport: sourceRestoreTestTransport(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			if bodyFailure {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(iotest.ErrReader(tls.RecordHeaderError{Msg: "invalid TLS record"}))}, nil
			}
			return nil, errors.New("transport refused this request")
		})}
		request := sourceRestoreCommitTestRequest(t, "https://factory.invalid/internal/substrate-source/owned", reply)
		if err := commitSubstrateSourceRestore(t.Context(), client, request, &reply); err == nil || calls.Load() != 1 {
			t.Fatalf("TLS/transport refusal retried: body=%v calls=%d err=%v", bodyFailure, calls.Load(), err)
		}
	}
	client := &http.Client{Transport: sourceRestoreTestTransport(func(*http.Request) (*http.Response, error) {
		t.Error("insecure commit reached the transport")
		return nil, errors.New("HTTP refused")
	})}
	if err := commitSubstrateSourceRestore(t.Context(), client, sourceRestoreCommitTestRequest(t, "http://factory.invalid", reply), &reply); err == nil {
		t.Fatal("insecure commit accepted")
	}
}

func TestSubstrateSourceRestoreCommitRejectsAuthorityAndMalformedACK(t *testing.T) {
	reply := sourceRestoreV2TestLease(t)
	data, _ := json.Marshal(sourceRestoreCommitTestACK(reply))
	ack := string(data)
	for _, response := range []struct {
		status int
		body   string
	}{
		{http.StatusUnauthorized, ""}, {http.StatusForbidden, ""}, {http.StatusNotFound, ""},
		{http.StatusConflict, ""}, {http.StatusGone, ""}, {http.StatusInternalServerError, ""},
		{http.StatusFound, ""}, {http.StatusOK, "{"}, {http.StatusOK, "null"},
		{http.StatusOK, strings.Repeat("x", 4097)},
		{http.StatusOK, ack + " {}"},
		{http.StatusOK, strings.Replace(ack, `"version":2,`, "", 1)},
		{http.StatusOK, strings.Replace(ack, `"version":2`, `"version":1`, 1)},
		{http.StatusOK, strings.Replace(ack, reply.ActorUID, reply.Checkpoint.ID, 1)},
		{http.StatusOK, strings.Replace(ack, reply.Checkpoint.ID, reply.ActorUID, 1)},
		{http.StatusOK, strings.Replace(ack, `"writerEpoch":2`, `"writerEpoch":3`, 1)},
		{http.StatusOK, strings.Replace(ack, `"writerEpoch":2`, `"writerEpoch":null`, 1)},
		{http.StatusOK, strings.Replace(ack, `"changeWriterEpoch":1,`, "", 1)},
		{http.StatusOK, strings.Replace(ack, `"changeWriterEpoch":1`, `"changeWriterEpoch":null`, 1)},
		{http.StatusOK, strings.Replace(ack, `"changeWriterEpoch":1`, `"changeWriterEpoch":0`, 1)},
		{http.StatusOK, strings.Replace(ack, `"changeWriterEpoch":1`, `"changeWriterEpoch":-1`, 1)},
		{http.StatusOK, strings.Replace(ack, `"changeWriterEpoch":1`, `"changeWriterEpoch":1.5`, 1)},
		{http.StatusOK, strings.Replace(ack, `"readOnly":false,`, "", 1)},
		{http.StatusOK, strings.Replace(ack, `"readOnly":false`, `"readOnly":null`, 1)},
		{http.StatusOK, strings.Replace(ack, `"readOnly":false`, `"readOnly":"false"`, 1)},
		{http.StatusOK, strings.Replace(ack, "}", `,"grant":true}`, 1)},
		{http.StatusOK, strings.Replace(ack, "}", `,"preservedTreeSHA256":"`+strings.Repeat("a", 64)+`"}`, 1)},
		{http.StatusOK, strings.Replace(ack, "}", `,"preservedTreeSHA256":""}`, 1)},
		{http.StatusOK, strings.Replace(ack, "}", `,"preservedTreeSHA256":null}`, 1)},
	} {
		t.Run(http.StatusText(response.status)+response.body[:min(len(response.body), 8)], func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(response.status)
				io.WriteString(w, response.body)
			}))
			defer server.Close()
			request := sourceRestoreCommitTestRequest(t, server.URL, reply)
			if err := commitSubstrateSourceRestore(t.Context(), server.Client(), request, &reply); err == nil || calls.Load() != 1 {
				t.Fatalf("permanent refusal retried/accepted: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestSubstrateSourceRestoreCommitCancellation(t *testing.T) {
	reply := sourceRestoreV2TestLease(t)
	for _, when := range []string{"before-request", "in-flight", "backoff"} {
		t.Run(when, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var calls atomic.Int32
			release := make(chan struct{})
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if when == "in-flight" {
					cancel()
					<-release
				} else {
					w.WriteHeader(http.StatusServiceUnavailable)
					time.AfterFunc(25*time.Millisecond, cancel)
				}
			}))
			defer server.Close()
			defer close(release)
			expected := int32(1)
			if when == "before-request" {
				cancel()
				expected = 0
			}
			err := commitSubstrateSourceRestore(ctx, server.Client(), sourceRestoreCommitTestRequest(t, server.URL, reply), &reply)
			if (!errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)) || calls.Load() != expected {
				t.Fatalf("commit cancellation: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestSubstrateSourceRestoreV2PublicationRequiresCommitACK(t *testing.T) {
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		t.Skip("Source materialization requires development UID 1000 or owned root Linux fixture")
	}
	project := filepath.Join(t.TempDir(), "producer")
	for _, args := range [][]string{{"init", project}, {"-C", project, "config", "factory.repositoryIdentity", "owned-project"}} {
		if output, err := exec.CommandContext(t.Context(), "git", args...).CombinedOutput(); err != nil {
			t.Fatalf("owned Git fixture: %v %s", err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(project, "saved"), []byte("canonical source"), 0600); err != nil {
		t.Fatal(err)
	}
	templateContent := []byte("{\"containers\":[]}\n")
	if err := os.Mkdir(filepath.Join(project, ".factory"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".factory/actor-template.json"), templateContent, 0600); err != nil {
		t.Fatal(err)
	}
	templateDigest := sha256.Sum256(templateContent)
	if err := filepath.WalkDir(project, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	source, err := workspacefiles.Open(project)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	archive, err := os.CreateTemp(t.TempDir(), "bundle-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	bundle, err := source.ExportBundle(archive)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(archive.Name())
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		outcome         string
		leases, commits int32
		success         bool
	}{
		{"lost-ack", 2, 2, true}, {"truncated-ack", 2, 2, true},
		{"502", 2, 2, true}, {"503", 2, 2, true}, {"504", 2, 2, true},
		{"revoked", 2, 2, false}, {"rejected", 2, 1, false}, {"wrong-ack", 2, 1, false},
		{"uncertain", 2, 5, false}, {"canceled", 2, 1, false}, {"lease-changed", 2, 0, false},
		{"bad-chunk", 1, 0, false}, {"bad-checksum", 1, 0, false},
		{"wrong-project", 1, 0, false}, {"bad-archive", 1, 0, false},
		{"role-drift-readonly", 2, 1, true}, {"role-drift-writable", 2, 1, true},
		{"lost-ack-role-drift", 2, 2, true}, {"input-stop-readonly", 2, 1, true},
		{"missing-readonly", 2, 1, false}, {"null-readonly", 2, 1, false},
		{"invalid-role-epoch", 2, 1, false}, {"input-stop-writable", 2, 1, false},
		{"role-drift-reget", 2, 1, true}, {"invalid-final-role-epoch", 2, 0, false},
		{"input-stop-final-writable", 2, 0, false}, {"input-stop-lease-changed", 2, 0, false},
		{"native-template-match", 2, 1, true}, {"native-template-mismatch", 1, 0, false},
		{"native-template-missing", 1, 0, false}, {"same-actor-template-edited", 2, 1, true},
		{"ack-before-marker-failure", 2, 1, false},
	} {
		t.Run(check.outcome, func(t *testing.T) {
			outcome := check.outcome
			reply := sourceRestoreV2TestLease(t)
			reply.Checkpoint.Bundle = bundle
			download := data
			if outcome == "bad-checksum" {
				reply.Checkpoint.Bundle.SHA256 = strings.Repeat("0", 64)
			} else if outcome == "bad-archive" {
				download = []byte("not a Source archive")
				hash := sha256.Sum256(download)
				digest := hex.EncodeToString(hash[:])
				reply.Checkpoint.Bundle = workspacefiles.Bundle{Version: 1, Bytes: int64(len(download)), SHA256: digest, Chunks: []string{digest}}
			}
			var b bootstrap
			b.ParentToken = "owned-parent"
			b.Source.ProjectID, b.Source.WorkspaceID = "owned-project", reply.Checkpoint.WorkspaceID
			if outcome == "wrong-project" {
				b.Source.ProjectID = "foreign-project"
			}
			b.Assignment.RuntimeAttemptID, b.Assignment.Generation = "owned-attempt", 2
			if strings.HasPrefix(outcome, "native-template-") || outcome == "same-actor-template-edited" {
				b.Assignment.ActorTemplatePath = ".factory/actor-template.json"
				b.ProjectTemplate = &nativeProjectTemplate{Path: b.Assignment.ActorTemplatePath, SHA256: hex.EncodeToString(templateDigest[:])}
				if outcome == "native-template-missing" {
					b.Assignment.ActorTemplatePath = ".factory/missing.json"
					b.ProjectTemplate.Path = b.Assignment.ActorTemplatePath
				}
				if outcome == "native-template-mismatch" || outcome == "same-actor-template-edited" {
					b.ProjectTemplate.SHA256 = strings.Repeat("f", 64)
				}
				if outcome == "same-actor-template-edited" {
					reply.Checkpoint.ActorUID, reply.CheckpointActorUID = reply.ActorUID, reply.ActorUID
					reply.Checkpoint.SeedID, reply.CheckpointSeedID = nil, nil
				}
			}
			if outcome == "role-drift-writable" {
				reply.ReadOnly = true
			}
			if strings.HasPrefix(outcome, "input-stop-") {
				input := ownedInputStop()
				reply.InputStop, reply.ReadOnly = &input, true
				reply.Checkpoint.ActorUID, reply.CheckpointActorUID = reply.ActorUID, reply.ActorUID
				reply.Checkpoint.SeedID, reply.CheckpointSeedID = nil, nil
				b.Assignment.RuntimeAttemptID = input.AttemptID
				b.InputStop = &struct {
					Version         int    `json:"version"`
					OpenCodeVersion string `json:"openCodeVersion"`
				}{1, input.Version}
			}
			root := t.TempDir()
			b.Assignment.WorkspaceFolder, b.Assignment.ConnectorStateDir = filepath.Join(root, "project"), filepath.Join(root, "connector")
			if err := os.Mkdir(b.Assignment.WorkspaceFolder, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(b.Assignment.WorkspaceFolder, "old"), []byte("retain me"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(b.Assignment.ConnectorStateDir, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json")
			if err := os.WriteFile(marker, []byte("previous cold start"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var leases, chunks, commits atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/internal/substrate-source/"+b.Assignment.RuntimeAttemptID ||
					r.Header.Get("Authorization") != "Bearer owned-parent" || r.Header.Get("X-Factory-Source-Protocol") != "2" ||
					r.Header.Get("X-Factory-Runtime-Actor-UID") != reply.ActorUID || r.Header.Get("X-Factory-Runtime-Generation") != "2" {
					t.Error("restore request lost its v2 recipient authority")
					w.WriteHeader(http.StatusForbidden)
					return
				}
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Error("execution marker exists before an exact commit ACK")
				}
				if r.Method == http.MethodGet && r.URL.RawQuery == "" {
					if leases.Add(1) > 2 {
						t.Error("commit recovery replayed lease acquisition")
					}
					current := reply
					if leases.Load() == 2 {
						switch outcome {
						case "lease-changed":
							saved := *reply.Checkpoint
							current.Checkpoint = &saved
							current.Checkpoint.Bundle.SHA256 = strings.Repeat("0", 64)
						case "role-drift-reget":
							current.ChangeWriterEpoch++
							current.ReadOnly = true
						case "invalid-final-role-epoch":
							current.ChangeWriterEpoch = 0
						case "input-stop-final-writable":
							current.ReadOnly = false
						case "input-stop-lease-changed":
							stop := *reply.InputStop
							current.InputStop = &stop
							current.InputStop.StopID = reply.Checkpoint.ID
						}
					}
					json.NewEncoder(w).Encode(current)
					return
				}
				if r.Method == http.MethodGet {
					if chunks.Add(1) > 1 || r.URL.Query().Get("checkpoint") != reply.Checkpoint.ID ||
						r.URL.Query().Get("chunk") != "0" || r.Header.Get("X-Factory-Source-Writer-Epoch") != "2" {
						t.Error("download identity changed or was replayed")
					}
					if outcome == "bad-chunk" {
						w.Write(bytes.Repeat([]byte("x"), len(download)))
					} else {
						w.Write(download)
					}
					return
				}
				if r.Method != http.MethodPost || r.URL.RawQuery != "" {
					t.Error("unexpected restore operation")
					w.WriteHeader(http.StatusForbidden)
					return
				}
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != `{"checkpointID":"`+reply.Checkpoint.ID+`","writerEpoch":2}` || r.Header.Get("Content-Type") != "application/json" {
					t.Error("commit body differs from the original lease")
				}
				if canonical, err := os.ReadFile(filepath.Join(b.Assignment.WorkspaceFolder, "saved")); err != nil || string(canonical) != "canonical source" {
					t.Error("commit preceded canonical Source publication")
				}
				if reply.InputStop == nil {
					// This must be durable BEFORE a commit can take effect. An
					// ACK followed by process death cannot rely on the role marker.
					data, err := os.ReadFile(filepath.Join(b.Assignment.ConnectorStateDir, "source-imported.json"))
					var imported map[string]any
					if err != nil || json.Unmarshal(data, &imported) != nil ||
						imported["version"] != float64(1) || imported["actorUID"] != reply.ActorUID ||
						imported["workspaceID"] != b.Source.WorkspaceID || imported["projectID"] != b.Source.ProjectID ||
						imported["attemptID"] != b.Assignment.RuntimeAttemptID || imported["generation"] != float64(2) ||
						imported["writerEpoch"] != float64(reply.WriterEpoch) || imported["checkpointID"] != reply.Checkpoint.ID {
						t.Error("Source commit preceded its private durable publication identity")
					}
				}
				count := commits.Add(1)
				ack := sourceRestoreCommitTestACK(reply)
				switch outcome {
				case "ack-before-marker-failure":
					// Make only final role publication fail after a valid ACK.
					if err := os.Mkdir(marker, 0700); err != nil {
						t.Error(err)
					}
					json.NewEncoder(w).Encode(ack)
				case "native-template-match", "same-actor-template-edited":
					json.NewEncoder(w).Encode(ack)
				case "rejected":
					w.WriteHeader(http.StatusForbidden)
				case "revoked":
					if count == 1 {
						w.WriteHeader(http.StatusBadGateway)
					} else {
						w.WriteHeader(http.StatusConflict)
					}
				case "uncertain":
					w.WriteHeader(http.StatusServiceUnavailable)
				case "canceled":
					cancel()
					w.WriteHeader(http.StatusServiceUnavailable)
				case "wrong-ack":
					ack["actorUID"] = reply.Checkpoint.ID
					json.NewEncoder(w).Encode(ack)
				case "role-drift-readonly", "role-drift-writable", "lost-ack-role-drift", "role-drift-reget":
					ack["changeWriterEpoch"] = reply.ChangeWriterEpoch + uint64(count)
					if outcome == "role-drift-reget" {
						ack["changeWriterEpoch"] = reply.ChangeWriterEpoch + 2
					}
					ack["readOnly"] = outcome == "role-drift-readonly" || (outcome == "lost-ack-role-drift" && count == 1)
					if outcome == "lost-ack-role-drift" && count == 1 {
						w.Header().Set("Content-Length", "4096")
					}
					json.NewEncoder(w).Encode(ack)
				case "missing-readonly", "null-readonly", "invalid-role-epoch", "input-stop-readonly", "input-stop-writable":
					switch outcome {
					case "missing-readonly":
						delete(ack, "readOnly")
					case "null-readonly":
						ack["readOnly"] = nil
					case "invalid-role-epoch":
						ack["changeWriterEpoch"] = 0
					case "input-stop-writable":
						ack["readOnly"] = false
					}
					json.NewEncoder(w).Encode(ack)
				default:
					if count == 1 {
						switch outcome {
						case "502", "503", "504":
							status := map[string]int{"502": 502, "503": 503, "504": 504}
							w.WriteHeader(status[outcome])
						case "truncated-ack":
							w.Header().Set("Content-Length", "200")
							io.WriteString(w, `{"version":2`)
						default:
							connection, _, err := w.(http.Hijacker).Hijack()
							if err != nil {
								t.Error(err)
								return
							}
							connection.Close()
						}
					} else {
						json.NewEncoder(w).Encode(sourceRestoreCommitTestACK(reply))
					}
				}
			}))
			defer server.Close()
			endpoint, _ := url.Parse(server.URL + "/internal/substrate-source/" + b.Assignment.RuntimeAttemptID)
			err := restoreSubstrateSource(ctx, b, reply.ActorUID, server.Client(), endpoint)
			if (err == nil) != check.success {
				t.Fatalf("commit result: %v", err)
			}
			if leases.Load() != check.leases || chunks.Load() != 1 || commits.Load() != check.commits {
				t.Fatalf("restore replay/order: leases=%d chunks=%d commits=%d", leases.Load(), chunks.Load(), commits.Load())
			}
			if stages, err := filepath.Glob(filepath.Join(root, ".factory-source-restore-*")); err != nil || len(stages) != 1 {
				t.Fatal("commit recovery replayed Source staging/import")
			}
			if check.success {
				restored, err := readNativeRestored(b, reply.ActorUID)
				epoch, readOnly := reply.ChangeWriterEpoch, reply.ReadOnly
				switch outcome {
				case "role-drift-readonly", "role-drift-writable", "lost-ack-role-drift":
					epoch += uint64(check.commits)
					readOnly = outcome == "role-drift-readonly"
				case "role-drift-reget":
					epoch += 2
					readOnly = false
				}
				if err != nil || restored.WriterEpoch != 2 || restored.ChangeWriterEpoch != epoch || restored.ReadOnly != readOnly {
					t.Fatalf("exact ACK did not publish its marker: %+v %v", restored, err)
				}
			} else if _, err := os.Stat(marker); outcome != "ack-before-marker-failure" && !os.IsNotExist(err) {
				t.Fatal("rejected/uncertain commit published an execution marker")
			}
			if outcome == "ack-before-marker-failure" {
				if _, err := readNativeRestored(b, reply.ActorUID); err == nil {
					t.Fatal("failed final marker publication admitted Work")
				}
				if err := os.Remove(marker); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(b.Assignment.WorkspaceFolder, "saved"), []byte("dirty after initial import"), 0600); err != nil {
					t.Fatal(err)
				}
				unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
				wire := map[string]any{"version": 2, "retained": true, "actorUID": reply.ActorUID,
					"writerEpoch": reply.WriterEpoch, "changeWriterEpoch": 99, "readOnly": true, "checkpoint": nil}
				// Unlike the dedicated retained fixture, this first import
				// already owns one staging directory. Its presence is evidence
				// of that import, not permission to replay it.
				var calls atomic.Int32
				retained := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.Method != http.MethodGet || r.URL.RawQuery != "" {
						t.Error("ACK/marker crash replayed an import/commit")
						w.WriteHeader(http.StatusForbidden)
						return
					}
					json.NewEncoder(w).Encode(wire)
				}))
				defer retained.Close()
				target, _ := url.Parse(retained.URL + "/internal/substrate-source/" + b.Assignment.RuntimeAttemptID)
				if err := restoreSubstrateSource(t.Context(), b, reply.ActorUID, retained.Client(), target); err != nil || calls.Load() != 1 {
					t.Fatalf("durable first publication was not recoverable through retained authority: calls=%d err=%v", calls.Load(), err)
				}
				unchanged()
				if current, err := readNativeRestored(b, reply.ActorUID); err != nil || current.ChangeWriterEpoch != 99 || !current.ReadOnly {
					t.Fatal("retained lease did not refresh the role after the ACK/marker crash:", err)
				}
			}
			if check.commits == 0 {
				if old, err := os.ReadFile(filepath.Join(b.Assignment.WorkspaceFolder, "old")); err != nil || string(old) != "retain me" {
					t.Fatal("invalid import/changed lease replaced canonical Source")
				}
			}
		})
	}
}
