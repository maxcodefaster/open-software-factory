package connector

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Use a subprocess because ProxyFromEnvironment and the system roots are cached.
// The production reader must traverse a real CONNECT tunnel and verified TLS.
func TestRuntimeEnvironmentProxySubprocess(t *testing.T) {
	if os.Getenv("FACTORY_ENVIRONMENT_PROXY_TEST") != "1" {
		return
	}
	assignment := validAssignment()
	version := uint64(3)
	assignment.EnvironmentVersion = &version
	assignment.ControlURL = os.Getenv("FACTORY_ENVIRONMENT_CONTROL_URL")
	deadline := 3 * time.Second
	if os.Getenv("FACTORY_ENVIRONMENT_PROXY_CASE") == "caller-deadline" {
		deadline = 80 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	defer cancel()
	started := time.Now()
	environment, err := readRuntimeEnvironment(ctx, assignment, "owned-environment-capability")
	success := os.Getenv("FACTORY_ENVIRONMENT_PROXY_EXPECT") == "success"
	if (err == nil) != success {
		t.Fatalf("environment read: %v", err)
	}
	if err != nil && (strings.Contains(err.Error(), "owned-environment-capability") ||
		strings.Contains(err.Error(), "secret-do-not-disclose")) {
		t.Fatal("environment failure disclosed private transport data")
	}
	if success && (environment.Version != version || len(environment.Bundle.Variables) != 1 ||
		environment.Bundle.Variables[0].Value != "owned-value") {
		t.Fatal("retried read lost the pinned environment")
	}
	if !success && time.Since(started) > time.Second {
		t.Fatal("permanent failure or caller cancellation was retried")
	}
}

func TestRuntimeEnvironmentRetriesOnlyTransientReadFailuresThroughTLSProxy(t *testing.T) {
	for _, scenario := range []struct {
		name               string
		proxyStatus        int
		originStatus       int
		host               string
		success            bool
		connects, requests int32
	}{
		{"tinyproxy-dns", 500, 0, "example.com", true, 2, 1},
		{"proxy-dns-500", 500, 0, "example.com", true, 2, 1},
		{"proxy-dns-502", 502, 0, "example.com", true, 2, 1},
		{"origin-unavailable", 0, 503, "example.com", true, 1, 2},
		{"origin-bad-gateway", 0, 502, "example.com", true, 1, 2},
		{"origin-gateway-timeout", 0, 504, "example.com", true, 1, 2},
		{"proxy-denied", 403, 0, "example.com", false, 1, 0},
		{"proxy-authentication", 407, 0, "example.com", false, 1, 0},
		{"origin-denied", 0, 403, "example.com", false, 1, 1},
		{"origin-unauthenticated", 0, 401, "example.com", false, 1, 1},
		{"wrong-serving-name", 0, 0, "wrong.factory.invalid", false, 1, 0},
		{"untrusted-ca", 0, 0, "example.com", false, 1, 0},
		{"origin-not-found", 0, 404, "example.com", false, 1, 1},
		{"wrong-version", 0, 0, "example.com", false, 1, 1},
		{"invalid-response", 0, 0, "example.com", false, 1, 1},
		{"redirect", 0, 307, "example.com", false, 1, 1},
		{"caller-deadline", 0, 503, "example.com", false, 1, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var connects, requests atomic.Int32
			target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempt := requests.Add(1)
				if r.Method != http.MethodGet ||
					r.URL.Path != "/internal/runtime-environment/"+validAssignment().RuntimeAttemptID ||
					r.Header.Get("Authorization") != "Bearer owned-environment-capability" ||
					r.Header.Get("X-Factory-Runtime-Generation") != "1" {
					t.Error("environment read changed its authority or immutable identity")
					w.WriteHeader(403)
					return
				}
				if scenario.originStatus != 0 && (attempt == 1 || !scenario.success) {
					w.Header().Set("Location", "https://foreign.factory.invalid/secret-do-not-disclose")
					w.WriteHeader(scenario.originStatus)
					w.Write([]byte("secret-do-not-disclose"))
					return
				}
				if scenario.name == "invalid-response" {
					w.Write([]byte("secret-do-not-disclose"))
					return
				}
				version := uint64(3)
				if scenario.name == "wrong-version" {
					version++
				}
				json.NewEncoder(w).Encode(runtimeEnvironment{
					Version: version,
					Bundle: environmentBundle{Variables: []environmentVariable{
						{Name: "API_KEY", Value: "owned-value", Runtime: true},
					}},
				})
			}))
			defer target.Close()
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempt := connects.Add(1)
				if r.Method != http.MethodConnect || r.Host != scenario.host+":443" ||
					r.Header.Get("Authorization") != "" {
					t.Error("proxy received a changed destination or origin capability")
					w.WriteHeader(403)
					return
				}
				if scenario.proxyStatus != 0 && (attempt == 1 || !scenario.success) {
					if scenario.name == "tinyproxy-dns" {
						client, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						defer client.Close()
						// Tinyproxy 1.11.2 uses this nonstandard reason phrase
						// when opensock fails, including temporary DNS failure.
						io.WriteString(client, "HTTP/1.0 500 Unable to connect\r\nConnection: close\r\n\r\nsecret-do-not-disclose")
						return
					}
					w.WriteHeader(scenario.proxyStatus)
					w.Write([]byte("secret-do-not-disclose"))
					return
				}
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
				io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
				done := make(chan struct{})
				go func() { io.Copy(upstream, client); close(done) }()
				io.Copy(client, upstream)
				client.Close()
				<-done
			}))
			defer proxy.Close()
			directory := t.TempDir()
			ca := filepath.Join(directory, "ca.pem")
			trust := pem.EncodeToMemory(&pem.Block{
				Type: "CERTIFICATE", Bytes: target.Certificate().Raw,
			})
			if scenario.name == "untrusted-ca" {
				trust = nil
			}
			if err := os.WriteFile(ca, trust, 0600); err != nil {
				t.Fatal(err)
			}
			command := exec.Command(os.Args[0], "-test.run=^TestRuntimeEnvironmentProxySubprocess$")
			for _, value := range os.Environ() {
				name := strings.SplitN(value, "=", 2)[0]
				if !strings.Contains(strings.ToLower(name), "proxy") &&
					name != "SSL_CERT_FILE" && name != "SSL_CERT_DIR" &&
					!strings.HasPrefix(name, "FACTORY_ENVIRONMENT_") {
					command.Env = append(command.Env, value)
				}
			}
			expected := "failure"
			if scenario.success {
				expected = "success"
			}
			command.Env = append(command.Env,
				"FACTORY_ENVIRONMENT_PROXY_TEST=1",
				"FACTORY_ENVIRONMENT_PROXY_CASE="+scenario.name,
				"FACTORY_ENVIRONMENT_PROXY_EXPECT="+expected,
				"FACTORY_ENVIRONMENT_CONTROL_URL=wss://"+scenario.host+"/internal/runtime-connect",
				"SSL_CERT_FILE="+ca, "SSL_CERT_DIR="+directory,
				"HTTPS_PROXY="+proxy.URL, "HTTP_PROXY="+proxy.URL, "NO_PROXY=",
			)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("environment subprocess: %v\n%s", err, output)
			}
			if connects.Load() != scenario.connects || requests.Load() != scenario.requests {
				t.Fatalf("CONNECTs=%d, reads=%d; expected %d and %d",
					connects.Load(), requests.Load(), scenario.connects, scenario.requests)
			}
		})
	}
}

func TestRuntimeEnvironmentReadRetryClassification(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		err   error
		retry bool
	}{
		{"temporary-dns", &net.DNSError{IsTemporary: true}, true},
		{"dns-timeout", &net.DNSError{IsTimeout: true}, true},
		{"denied-dns", &net.DNSError{IsNotFound: true, IsTemporary: true}, false},
		{"untrusted-certificate", x509.UnknownAuthorityError{}, false},
		{"wrong-certificate-name", x509.HostnameError{}, false},
		{"caller-cancelled", context.Canceled, false},
		{"connection-closed", io.EOF, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if retryRuntimeEnvironmentRead(&url.Error{Op: "Get", Err: scenario.err}) != scenario.retry {
				t.Fatal("environment read retry classification changed")
			}
		})
	}
}
