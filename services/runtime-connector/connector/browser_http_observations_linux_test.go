//go:build linux

package connector

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestBrowserHTTPObservationsReadLongOwnedUnixPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), strings.Repeat("owned-", 20))
	directory := filepath.Join(root, "socket")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	// Linux's pathname bound applies to sockaddr_un, not the actual directory
	// length. Bind through the same pinned directory without shortening owner IDs.
	listener, err := net.Listen("unix", "/proc/self/fd/"+strconv.Itoa(int(dir.Fd()))+"/observations.sock")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("app") != "web" || r.URL.Query().Get("after") != "7" {
			t.Error("owned read changed its App or cursor")
		}
		json.NewEncoder(w).Encode(browserHTTPObservationPage{Observations: []browserHTTPObservation{}, NextAfter: 7})
	})}
	defer server.Close()
	go server.Serve(listener)
	result, err := readBrowserHTTPObservations(context.Background(), root, "web", 7)
	if err != nil || !strings.Contains(string(result), "nextAfter") {
		t.Fatal("safe observations cannot read the real long owned directory", err)
	}
}
