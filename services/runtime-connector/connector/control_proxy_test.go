package connector

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ProxyFromEnvironment caches the process environment. Each control exercises
// the real dialControl in a fresh process, not a substituted Proxy callback.
func TestControlProxySubprocess(t *testing.T) {
	if os.Getenv("FACTORY_PROXY_SUBPROCESS") != "1" {
		return
	}
	a := validAssignment()
	a.ControlURL = os.Getenv("FACTORY_PROXY_CONTROL_URL")
	for _, role := range []string{"parent", "child"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		c, err := dialControl(ctx, a, role, "scoped-connector-capability")
		cancel()
		if c != nil {
			c.close()
		}
		if (err == nil) != (os.Getenv("FACTORY_PROXY_EXPECT") == "success") {
			t.Fatalf("%s connection: %v", role, err)
		}
	}
	if source := os.Getenv("FACTORY_PROXY_ROTATE_FROM"); source != "" {
		b, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("FACTORY_CONNECTOR_CA_FILE"), b, 0600); err != nil {
			t.Fatal(err)
		}
		for _, role := range []string{"parent", "child"} {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			c, err := dialControl(ctx, a, role, "scoped-connector-capability")
			cancel()
			if err != nil {
				t.Fatalf("%s after CA rotation: %v", role, err)
			}
			c.close()
		}
	}
	if source := os.Getenv("FACTORY_PROXY_REMOVE_TRUST"); source != "" {
		b, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("SSL_CERT_FILE"), b, 0600); err != nil {
			t.Fatal(err)
		}
		for _, role := range []string{"parent", "child"} {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			c, err := dialControl(ctx, a, role, "scoped-connector-capability")
			cancel()
			if c != nil {
				c.close()
			}
			if err == nil {
				t.Fatalf("%s retained removed CA after projected bundle rotation", role)
			}
		}
	}
}

func TestControlProxyTLSAndRotation(t *testing.T) {
	var registrations atomic.Int32
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer scoped-connector-capability" || r.Header.Get("X-Factory-Runtime-Actor-UID") != "owned-actor-uid" {
			t.Error("lost connector authority")
			w.WriteHeader(401)
			return
		}
		if role := r.Header.Get("X-Factory-Connector-Role"); role != "parent" && role != "child" {
			t.Error("invalid role")
			return
		}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		registrations.Add(1)
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer target.Close()
	var connects atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Header.Get("Authorization") != "" {
			t.Error("proxy received origin credentials or non-CONNECT")
			w.WriteHeader(403)
			return
		}
		connects.Add(1)
		upstream, err := net.Dial("tcp", target.Listener.Addr().String())
		if err != nil {
			t.Error(err)
			return
		}
		defer upstream.Close()
		client, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer client.Close()
		_, _ = io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
		done := make(chan struct{})
		go func() { _, _ = io.Copy(upstream, client); close(done) }()
		_, _ = io.Copy(client, upstream)
		client.Close()
		<-done
	}))
	defer proxy.Close()
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) }))
	defer denied.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: target.Certificate().Raw})
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "untrusted.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	wrongCA := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	for _, tc := range []struct {
		name, host, proxy, expect string
		trusted, rotate           bool
	}{
		{"parent-child-proxy", "example.com", proxy.URL, "success", true, false},
		{"wrong-serving-name", "not-in-certificate.invalid", proxy.URL, "failure", true, false},
		{"missing-ca", "example.com", proxy.URL, "failure", false, false},
		{"proxy-denied", "example.com", denied.URL, "failure", true, false},
		{"no-proxy-no-direct-route", "unresolvable.factory.invalid", "", "failure", true, false},
		{"ca-rotation", "example.com", proxy.URL, "failure", false, true},
		{"profile-ca-removal", "example.com", proxy.URL, "success", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			caFile := filepath.Join(dir, "ca.pem")
			good := filepath.Join(dir, "good.pem")
			untrusted := filepath.Join(dir, "untrusted.pem")
			if err := os.WriteFile(untrusted, wrongCA, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(good, ca, 0600); err != nil {
				t.Fatal(err)
			}
			content := wrongCA
			if tc.trusted {
				content = ca
			}
			if err := os.WriteFile(caFile, content, 0600); err != nil {
				t.Fatal(err)
			}
			command := exec.Command(os.Args[0], "-test.run=^TestControlProxySubprocess$")
			for _, e := range os.Environ() {
				key := strings.SplitN(e, "=", 2)[0]
				if !strings.Contains(strings.ToLower(key), "proxy") && key != "FACTORY_CONNECTOR_CA_FILE" && key != "FACTORY_SUBSTRATE_ACTOR_UID" && key != "SSL_CERT_FILE" {
					command.Env = append(command.Env, e)
				}
			}
			extraCA := caFile
			if tc.name == "profile-ca-removal" {
				extraCA = ""
			}
			command.Env = append(command.Env, "FACTORY_PROXY_SUBPROCESS=1", "FACTORY_PROXY_CONTROL_URL=wss://"+tc.host+"/internal/runtime-connect", "FACTORY_PROXY_EXPECT="+tc.expect, "HTTPS_PROXY="+tc.proxy, "HTTP_PROXY="+tc.proxy, "NO_PROXY=", "FACTORY_CONNECTOR_CA_FILE="+extraCA, "FACTORY_SUBSTRATE_ACTOR_UID=owned-actor-uid")
			if tc.rotate {
				command.Env = append(command.Env, "FACTORY_PROXY_ROTATE_FROM="+good)
			}
			if tc.name == "profile-ca-removal" {
				command.Env = append(command.Env, "SSL_CERT_FILE="+caFile, "FACTORY_PROXY_REMOVE_TRUST="+untrusted)
			}
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("control subprocess: %v\n%s", err, output)
			}
		})
	}
	if registrations.Load() != 6 || connects.Load() < 14 {
		t.Fatalf("registrations=%d CONNECTs=%d", registrations.Load(), connects.Load())
	}
}
