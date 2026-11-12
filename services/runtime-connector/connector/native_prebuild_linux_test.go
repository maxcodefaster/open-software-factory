//go:build linux

package connector

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativePrebuildBaseReusesTheNetworklessOwnedTransportWithoutPrivateBuildInputs(t *testing.T) {
	assignment, directory := nativeDependencyFixture(t, "created")
	nativePrebuildTransportFixture(t, assignment)
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	assignment.RegistryCAFile = filepath.Join(directory, "public-ca.pem")
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(assignment.RegistryCAFile, certificate, 0600); err != nil {
		t.Fatal(err)
	}
	assignment.RuntimeEnvironment = map[string]string{"PRIVATE_RUNTIME_ONLY": "never-build-this"}
	var selected *nativePrebuildBase
	for i := 0; i < 2; i++ {
		before, _ := os.ReadFile(filepath.Join(directory, "trace"))
		base, err := prepareNativePrebuildBase(context.Background(), assignment, projectImage("a"))
		if err != nil {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(filepath.Join(directory, "trace"))
		if string(before) != string(after) {
			t.Fatal("recipe matching prepared a private image")
		}
		if _, err := activateNativePrebuildBase(context.Background(), base); err != nil {
			t.Fatal(err)
		}
		if base == nil || base.base != projectImage("a") || !regexpIdentity(base.transport) || !strings.HasPrefix(base.reference, "factory-native-dependencies:") || base.assignment.preparedRootFSImage != "sha256:"+strings.Repeat("b", 64) {
			t.Fatal("native prebuild base lost its exact authority")
		}
		if selected != nil && selected.transport != base.transport {
			t.Fatal("unchanged public transport changed its recipe identity")
		}
		selected = base
	}
	trace, _ := os.ReadFile(filepath.Join(directory, "trace"))
	if strings.Count(string(trace), "\nbuild ") != 1 || !strings.Contains(string(trace), "build --network=none --pull=false") || strings.Contains(string(trace), "never-build-this") {
		t.Fatal("native prebuild transport repeated its build, enabled networking, or exported Runtime grants")
	}
	trust, _ := os.ReadFile(filepath.Join(directory, "trust.pem"))
	if string(trust) != string(certificate) {
		t.Fatal("native prebuild did not use the exact admitted public trust")
	}
	if err := os.Remove(filepath.Join(directory, "outcome")); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareNativePrebuildBase(context.Background(), assignment, projectImage("a")); err != nil {
		t.Fatalf("recipe matching required the producer's evicted image graph: %v", err)
	}
	if err := os.WriteFile(assignment.RegistryCAFile, append(certificate, []byte("-----BEGIN PRIVATE KEY-----\nnever-export-this")...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareNativePrebuildBase(context.Background(), assignment, projectImage("a")); err == nil {
		t.Fatal("native prebuild exported a private key")
	}
	after, _ := os.ReadFile(filepath.Join(directory, "trace"))
	if string(after) != string(trace) {
		t.Fatal("rejected trust reached the private daemon")
	}
}
