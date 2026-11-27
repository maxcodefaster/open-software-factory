package connector

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func nativeProjectServiceFixture() nativeProject {
	version := uint64(7)
	return nativeProject{Container: "database", EntryToken: "owned-entry",
		Assignment: Assignment{Version: AssignmentVersion, RuntimeAttemptID: "owned-attempt",
			Generation: 2, ControlURL: "wss://factory.example/internal/runtime-connect", EnvironmentVersion: &version},
		Command: []string{"postgres", "-c", "listen_addresses=127.0.0.1"}}
}

func TestNativeProjectEntryKeepsOnlyItsOwnExecutionAuthority(t *testing.T) {
	entry := nativeProjectServiceFixture()
	encode := func(value nativeProject) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if _, err := decodeNativeProject(encode(entry)); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*nativeProject){
		func(p *nativeProject) { p.ChildToken = "must-not-reach-service" },
		func(p *nativeProject) { p.Assignment.RepositoryURL = "https://factory.example/private-source" },
		func(p *nativeProject) { p.Assignment.ControlURL = "ws://factory.example/internal/runtime-connect" },
		func(p *nativeProject) { p.Assignment.EnvironmentVersion = nil },
		func(p *nativeProject) { p.Assignment.WorkspaceFolder = "/another-container" },
		func(p *nativeProject) { p.Container = "../work" },
		func(p *nativeProject) { p.Command = nil },
		func(p *nativeProject) { p.Command = []string{"postgres", "\x00"} },
	} {
		current := entry
		mutate(&current)
		if _, err := decodeNativeProject(encode(current)); err == nil {
			t.Fatal("foreign or invalid service authority was accepted")
		}
	}
	if _, err := decodeNativeProject(encode(entry) + " {}"); err == nil {
		t.Fatal("trailing bootstrap data was accepted")
	}
	work := entry
	work.Container, work.Command, work.ChildToken = "work", nil, "owned-child"
	work.Assignment = validAssignment()
	work.Assignment.ControlURL = entry.Assignment.ControlURL
	work.Assignment.EnvironmentVersion = entry.Assignment.EnvironmentVersion
	if _, err := decodeNativeProject(encode(work)); err != nil {
		t.Fatal(err)
	}
}

func TestNativeProjectWaitsForItsExactSourceAdmissionWithoutCredentials(t *testing.T) {
	entry := nativeProjectServiceFixture()
	actorUID := "bda5f2f0-5ef7-4e8d-92d4-167c8397ad31"
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/internal/runtime-environment/owned-attempt" ||
			r.Header.Get("Authorization") != "Bearer owned-entry" ||
			r.Header.Get("X-Factory-Runtime-Generation") != "2" ||
			r.Header.Get("X-Factory-Runtime-Actor-UID") != actorUID ||
			r.Header.Get("X-Factory-Runtime-Container") != "database" {
			t.Error("native entry lost its exact Actor/container binding")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		json.NewEncoder(w).Encode(runtimeEnvironment{Version: 7, Bundle: environmentBundle{
			Variables: []environmentVariable{{Name: "DATABASE_URL", Value: "owned-runtime", Runtime: true}}}})
	}))
	defer server.Close()
	entry.Assignment.ControlURL = strings.Replace(server.URL, "https://", "wss://", 1) + "/internal/runtime-connect"
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	got, err := readNativeProjectEnvironment(ctx, entry, actorUID, server.Client())
	if err != nil || calls.Load() != 2 || len(got.Bundle.Variables) != 1 {
		t.Fatalf("native admission not confirmed exactly: %+v %v", got, err)
	}
}

func TestNativeProjectRejectsNonRuntimeAndTransportAuthority(t *testing.T) {
	entry := nativeProjectServiceFixture()
	for _, bundle := range []environmentBundle{
		{Variables: []environmentVariable{{Name: "DISABLED", Value: "secret", Runtime: false}}},
		{Variables: []environmentVariable{{Name: "HTTPS_PROXY", Value: "foreign", Runtime: true}}},
		{Variables: []environmentVariable{{Name: "ATE_TOKEN", Value: "foreign", Runtime: true}}},
	} {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(runtimeEnvironment{Version: 7, Bundle: bundle})
		}))
		entry.Assignment.ControlURL = strings.Replace(server.URL, "https://", "wss://", 1)
		_, err := readNativeProjectEnvironment(t.Context(), entry, "bda5f2f0-5ef7-4e8d-92d4-167c8397ad31", server.Client())
		server.Close()
		if err == nil {
			t.Fatal("Project received non-runtime authority")
		}
	}
}

func TestNativeProjectRejectsRetiredEnvironmentFields(t *testing.T) {
	for _, body := range []string{
		`{"version":7,"bundle":{"variables":[{"name":"APP_TOKEN","value":"owned","runtime":true,"verification":false,"build":false}]}}`,
		`{"version":7,"bundle":{"variables":[],"registries":[]}}`,
	} {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(body))
		}))
		entry := nativeProjectServiceFixture()
		entry.Assignment.ControlURL = strings.Replace(server.URL, "https://", "wss://", 1)
		_, err := readNativeProjectEnvironment(t.Context(), entry, "bda5f2f0-5ef7-4e8d-92d4-167c8397ad31", server.Client())
		server.Close()
		if err == nil {
			t.Error("native Environment still accepts retired image-build or registry fields")
		}
	}
}

func TestNativeWriterGateNeverReopensAfterUnconfirmedFreezeOrRevocation(t *testing.T) {
	if err := (*nativeProjectWriterGate)(nil).Start(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	gate := &nativeProjectWriterGate{}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := gate.Freeze(ctx); err == nil {
		t.Fatal("ordinary test process confirmed a native freeze")
	}
	started := false
	if err := gate.Start(func() error { started = true; return nil }); err == nil || started {
		t.Fatal("unconfirmed freeze allowed a new Project writer")
	}
	revoked := errors.New("current authority revoked")
	gate.SetRefresh(func(context.Context) error { return revoked })
	if err := gate.Resume(t.Context()); !errors.Is(err, revoked) || !gate.Frozen() {
		t.Fatal("revocation resumed native writers")
	}
}
