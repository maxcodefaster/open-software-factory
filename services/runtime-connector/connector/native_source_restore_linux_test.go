package connector

import (
	"context"
	"crypto/tls"
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
