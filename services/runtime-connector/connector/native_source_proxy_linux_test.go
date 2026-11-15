package connector

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func TestNativeSourceProxyAllowsCompleteCheckpointPastOrdinaryHeaderDeadline(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "source.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	service := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/workspaces/owned/checkpoint" || r.Header.Get("X-Factory-Writer-Epoch") != "7" ||
			r.Header.Get("Authorization") != "Bearer owned-source-capability" {
			http.Error(w, "wrong Source authority", http.StatusForbidden)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(10*time.Second + 100*time.Millisecond):
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"complete":true}`)
	})}
	go service.Serve(listener)
	defer service.Close()
	proxy, transport := nativeSourceProxy(socket, workspacefiles.Access{
		Token: "owned-source-capability", ServiceID: "source-owned", Epoch: 3,
	})
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/v1/workspaces/owned/checkpoint", nil)
	request.Header.Set("X-Factory-Writer-Epoch", "7")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != `{"complete":true}` {
		t.Fatalf("complete Source checkpoint was cut off by Parent: %d %s", response.Code, response.Body.String())
	}
}

func TestNativeSourceProxyStillHonorsCallerCancellation(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "source.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	cancelled := make(chan struct{})
	service := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		close(cancelled)
	})}
	go service.Serve(listener)
	defer service.Close()
	proxy, transport := nativeSourceProxy(socket, workspacefiles.Access{Token: "owned-source-capability"})
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/v1/workspaces/owned/checkpoint", nil)
	response := httptest.NewRecorder()
	started := time.Now()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || time.Since(started) > time.Second {
		t.Fatalf("Source caller cancellation did not end its proxy request: %d", response.Code)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("the abandoned Source request was not cancelled")
	}
}
