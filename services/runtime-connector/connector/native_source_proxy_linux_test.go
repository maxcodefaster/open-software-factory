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
	for _, admitted := range []bool{false, true} {
		name := "before-source-admission"
		if admitted {
			name = "after-source-admission"
		}
		t.Run(name, func(t *testing.T) {
			socket := filepath.Join(t.TempDir(), "source.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			entered := make(chan struct{})
			cancelled := make(chan struct{})
			service := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				<-r.Context().Done()
				close(cancelled)
			})}
			go service.Serve(listener)
			defer service.Close()
			proxy, transport := nativeSourceProxy(socket, workspacefiles.Access{Token: "owned-source-capability"})
			defer transport.CloseIdleConnections()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if !admitted {
				cancel()
			}
			request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/v1/workspaces/owned/checkpoint", nil)
			response := httptest.NewRecorder()
			done := make(chan struct{})
			go func() {
				proxy.ServeHTTP(response, request)
				close(done)
			}()
			if admitted {
				// A caller deadline can expire before Source receives the request.
				// Wait for admission before checking upstream cancellation.
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("Source request was not admitted")
				}
				cancel()
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("Source caller cancellation did not end its proxy request")
			}
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("Source caller cancellation returned %d", response.Code)
			}
			if admitted {
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("the abandoned Source request was not cancelled")
				}
			} else {
				select {
				case <-entered:
					t.Fatal("an already cancelled request reached Source")
				default:
				}
			}
		})
	}
}
