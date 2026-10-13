package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserClientFixedCallsNoRedirectOrMutationReplay(t *testing.T) {
	const turn = "11111111-1111-4111-a111-111111111111"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/fixed/"+turn || r.Header.Get("Authorization") != "Bearer owned-fixture-capability" {
			t.Error("browser execution scope changed")
		}
		var rpc struct {
			ID     string          `json:"id"`
			Params browserToolCall `json:"params"`
		}
		json.NewDecoder(r.Body).Decode(&rpc)
		if rpc.Params.Name == "browser_click" {
			http.Redirect(w, r, "/foreign", http.StatusTemporaryRedirect)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": map[string]any{"content": []any{map[string]string{"type": "text", "text": "Declared App only"}}, "structuredContent": &browserInspectionContext{SessionID: turn, TurnID: turn, App: "web", HeadCommit: strings.Repeat("a", 40)}}})
	}))
	defer server.Close()
	var output bytes.Buffer
	run := func(call string) error {
		return runBuildBrowserClient(context.Background(), turn, server.URL+"/fixed", "owned-fixture-capability", strings.NewReader(call), &output)
	}
	if err := run(`{"name":"browser_snapshot","arguments":{}}`); err != nil || !strings.Contains(output.String(), "Declared App only\n") || !strings.Contains(output.String(), "Factory observation: turn="+turn) {
		t.Fatalf("fixed client failed: %s %v", &output, err)
	}
	if err := run(`{"name":"browser_click","arguments":{"uid":"1_2"}}`); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls != 2 {
		t.Fatal("mutation replayed or redirect followed")
	}
	for _, call := range []string{`{"name":"evaluate_script","arguments":{}}`, `{"name":"browser_open","arguments":{"app":"web","path":"http://metadata/"}}`, `{"name":"browser_screenshot","arguments":{"filePath":"/tmp/file"}}`, `{"name":"browser_snapshot","arguments":{}} {}`, strings.Repeat("x", 16385)} {
		if run(call) == nil {
			t.Fatal("unsupported client input accepted")
		}
	}
	if calls != 2 {
		t.Fatal("unsupported input reached Factory")
	}
}

func TestBrowserDockerObservationIsBounded(t *testing.T) {
	var output browserDockerOutput
	if _, err := io.Copy(&output, strings.NewReader(strings.Repeat("x", 128<<10))); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("x")); err == nil || output.Len() != 128<<10 {
		t.Fatal("Docker observation grew beyond its bound")
	}
}

func TestBrowserClientReportsFailedInspectionWithoutClaimingProvenance(t *testing.T) {
	const turn = "11111111-1111-4111-a111-111111111111"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var rpc struct {
			ID string `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&rpc)
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": map[string]any{
			"isError": true, "content": []any{map[string]string{"type": "text", "text": "Pinned browser startup was not confirmed"}},
		}})
	}))
	defer server.Close()
	var output bytes.Buffer
	err := runBuildBrowserClient(context.Background(), turn, server.URL, "owned-fixture-capability", strings.NewReader(`{"name":"browser_snapshot","arguments":{}}`), &output)
	if err == nil || !strings.Contains(output.String(), "Pinned browser startup was not confirmed") || strings.Contains(output.String(), "Factory observation:") {
		t.Fatalf("failed inspection hid the actionable error or claimed success: %s %v", &output, err)
	}
}
