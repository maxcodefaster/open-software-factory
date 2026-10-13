package workspacefiles

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testService(t *testing.T) (*Service, *httptest.Server, Access) {
	t.Helper()
	source, _ := testSource(t)
	access := Access{WorkspaceID: "workspace-a", ServiceID: "source-a", Epoch: 7, Token: strings.Repeat("a", 32)}
	service, err := NewService(source, access)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service)
	t.Cleanup(server.Close)
	t.Cleanup(service.Revoke)
	return service, server, access
}

func serviceRequest(t *testing.T, server *httptest.Server, access Access, operation string, body any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/workspaces/"+access.WorkspaceID+"/"+operation, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+access.Token)
	request.Header.Set("X-Factory-Source-Service", access.ServiceID)
	request.Header.Set("X-Factory-Source-Epoch", "7")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestIndependentSourceServiceScopeAndWrites(t *testing.T) {
	service, server, access := testService(t)
	response := serviceRequest(t, server, access, "write", map[string]any{"path": "app.ts", "content": []byte("original"), "version": ""})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create source: %d", response.StatusCode)
	}
	var created File
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Version == "" || string(created.Content) != "original" {
		t.Fatalf("create acknowledgement: %#v", created)
	}
	response = serviceRequest(t, server, access, "read", map[string]string{"path": "app.ts"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("read source: %d", response.StatusCode)
	}
	for _, alternate := range []Access{
		{WorkspaceID: "workspace-b", ServiceID: access.ServiceID, Token: access.Token},
		{WorkspaceID: access.WorkspaceID, ServiceID: "source-b", Token: access.Token},
		{WorkspaceID: access.WorkspaceID, ServiceID: access.ServiceID, Token: "wrong"},
	} {
		response = serviceRequest(t, server, alternate, "read", map[string]string{"path": "app.ts"})
		if response.StatusCode == http.StatusOK {
			t.Fatalf("service accepted unrelated scope: %#v", alternate)
		}
		body, _ := io.ReadAll(response.Body)
		if bytes.Contains(body, []byte(access.Token)) || bytes.Contains(body, []byte("original")) {
			t.Fatal("scope denial disclosed source or credential")
		}
	}
	response = serviceRequest(t, server, access, "write", map[string]any{"path": "app.ts", "content": []byte("stale"), "version": ""})
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("blind overwrite did not preserve current content: %d", response.StatusCode)
	}
	response = serviceRequest(t, server, access, "write", map[string]any{"path": "app.ts", "content": []byte("edited"), "version": created.Version})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("observed-version save: %d", response.StatusCode)
	}
	service.Revoke()
	response = serviceRequest(t, server, access, "read", map[string]string{"path": "app.ts"})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("revoked service admitted file operation: %d", response.StatusCode)
	}
}

func TestIndependentSourceServiceRevokesWatch(t *testing.T) {
	service, server, access := testService(t)
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/v1/workspaces/"+access.WorkspaceID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+access.Token)
	request.Header.Set("X-Factory-Source-Service", access.ServiceID)
	request.Header.Set("X-Factory-Source-Epoch", "7")
	response, err := server.Client().Do(request)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("open scoped events: %v, %v", response, err)
	}
	defer response.Body.Close()
	service.Revoke()
	done := make(chan error, 1)
	go func() { _, err := io.ReadAll(response.Body); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("revocation left an event stream open")
	}
}

func TestIndependentSourceServiceRejectsUnknownCommands(t *testing.T) {
	_, server, access := testService(t)
	for _, operation := range []string{"shell", "exec", "tunnel", "write"} {
		response := serviceRequest(t, server, access, operation, map[string]any{"path": "app.ts", "command": "node -v"})
		if response.StatusCode == http.StatusOK {
			t.Fatalf("arbitrary or unknown command accepted: %s", operation)
		}
	}
}

func TestIndependentSourceExplorerOperations(t *testing.T) {
	service, server, access := testService(t)
	call := func(operation string, body map[string]any, status int) {
		t.Helper()
		response := serviceRequest(t, server, access, operation, body)
		if response.StatusCode != status {
			t.Fatalf("%s returned %d, expected %d", operation, response.StatusCode, status)
		}
	}
	call("mkdir", map[string]any{"path": "src"}, http.StatusOK)
	call("mkdir", map[string]any{"path": "src"}, http.StatusOK)
	call("write", map[string]any{"path": "src/app.ts", "content": []byte("source")}, http.StatusOK)
	call("rename", map[string]any{"path": "src/app.ts", "destination": "src/main.ts", "overwrite": false}, http.StatusOK)
	call("read", map[string]any{"path": "src/app.ts"}, http.StatusNotFound)
	call("read", map[string]any{"path": "src/main.ts"}, http.StatusOK)
	call("write", map[string]any{"path": "src/other.ts", "content": []byte("other")}, http.StatusOK)
	call("rename", map[string]any{"path": "src/main.ts", "destination": "src/other.ts", "overwrite": false}, http.StatusConflict)
	call("delete", map[string]any{"path": "src", "recursive": false}, http.StatusConflict)
	call("delete", map[string]any{"path": "src", "recursive": true}, http.StatusOK)
	call("stat", map[string]any{"path": "src"}, http.StatusNotFound)
	for _, name := range []string{"", ".git", "../outside"} {
		call("delete", map[string]any{"path": name, "recursive": true}, http.StatusForbidden)
		call("mkdir", map[string]any{"path": name}, http.StatusForbidden)
	}
	service.Revoke()
	call("mkdir", map[string]any{"path": "revoked"}, http.StatusForbidden)
}

func TestWriterFenceRejectsDelayedSaveAfterTakeover(t *testing.T) {
	service, server, access := testService(t)
	// A decoded old save may reach the service after Factory's request timed out.
	fence := serviceRequest(t, server, access, "fence", map[string]any{"writerEpoch": 4, "writable": true})
	if fence.StatusCode != http.StatusOK {
		t.Fatalf("writer fence was not acknowledged: %d", fence.StatusCode)
	}
	call := func(epoch string, content string) int {
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/workspaces/"+access.WorkspaceID+"/write", strings.NewReader(`{"path":"late.ts","content":"`+content+`"}`))
		request.Header.Set("Authorization", "Bearer "+access.Token)
		request.Header.Set("X-Factory-Source-Service", access.ServiceID)
		request.Header.Set("X-Factory-Source-Epoch", "7")
		request.Header.Set("X-Factory-Writer-Epoch", epoch)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if call("4", "b3JpZ2luYWw=") != http.StatusOK {
		t.Fatal("current writer cannot save")
	}
	fence = serviceRequest(t, server, access, "fence", map[string]any{"writerEpoch": 5, "writable": false})
	if fence.StatusCode != http.StatusOK {
		t.Fatal("takeover fence failed")
	}
	if call("4", "bGF0ZQ==") != http.StatusConflict {
		t.Fatal("old delayed writer changed files")
	}
	if call("5", "bGF0ZQ==") != http.StatusConflict {
		t.Fatal("Agent observation permits human save")
	}
	current, err := service.source.Read("late.ts")
	if err != nil || string(current.Content) != "original" {
		t.Fatal("takeover lost current source")
	}
	fence = serviceRequest(t, server, access, "fence", map[string]any{"writerEpoch": 4, "writable": true})
	if fence.StatusCode != http.StatusConflict {
		t.Fatal("stale fence re-enabled old writer")
	}
}

func TestWriterFenceWaitsForInFlightFilesystemSave(t *testing.T) {
	service, server, access := testService(t)
	if serviceRequest(t, server, access, "fence", map[string]any{"writerEpoch": 4, "writable": true}).StatusCode != http.StatusOK {
		t.Fatal("initial writer fence failed")
	}
	// Block the actual filesystem write after the service admits its writer.
	// No mock filesystem or production test hook is needed.
	service.source.writes.Lock()
	locked := true
	defer func() {
		if locked {
			service.source.writes.Unlock()
		}
	}()
	saved := make(chan int, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/workspaces/"+access.WorkspaceID+"/write", strings.NewReader(`{"path":"in-flight.ts","content":"c2F2ZWQ="}`))
		request.Header.Set("Authorization", "Bearer "+access.Token)
		request.Header.Set("X-Factory-Source-Service", access.ServiceID)
		request.Header.Set("X-Factory-Source-Epoch", "7")
		request.Header.Set("X-Factory-Writer-Epoch", "4")
		response, err := server.Client().Do(request)
		if err != nil {
			saved <- 0
			return
		}
		defer response.Body.Close()
		saved <- response.StatusCode
	}()
	deadline := time.Now().Add(time.Second)
	for service.writes.TryLock() {
		service.writes.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("save did not enter its filesystem operation")
		}
		time.Sleep(time.Millisecond)
	}
	fenced := make(chan int, 1)
	go func() {
		body := strings.NewReader(`{"writerEpoch":5,"writable":false}`)
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/workspaces/"+access.WorkspaceID+"/fence", body)
		request.Header.Set("Authorization", "Bearer "+access.Token)
		request.Header.Set("X-Factory-Source-Service", access.ServiceID)
		request.Header.Set("X-Factory-Source-Epoch", "7")
		response, err := server.Client().Do(request)
		if err != nil {
			fenced <- 0
			return
		}
		defer response.Body.Close()
		fenced <- response.StatusCode
	}()
	select {
	case <-fenced:
		t.Fatal("handoff acknowledged before the admitted filesystem save completed")
	case <-time.After(25 * time.Millisecond):
	}
	service.source.writes.Unlock()
	locked = false
	if <-saved != http.StatusOK || <-fenced != http.StatusOK {
		t.Fatal("save or subsequent fence did not settle")
	}
	file, err := service.source.Read("in-flight.ts")
	if err != nil || string(file.Content) != "saved" {
		t.Fatal("handoff did not retain the completed save")
	}
}
