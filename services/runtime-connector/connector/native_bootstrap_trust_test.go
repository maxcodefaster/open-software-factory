package connector

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func bootstrapTrustServer(t *testing.T, name string) (*httptest.Server, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true,
		KeyUsage:    x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, name)
	}))
	server.Config.ErrorLog = nil
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func bootstrapTrustClient(path string) (*http.Client, error) {
	trust, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(trust) {
		return nil, fmt.Errorf("selected trust contains no certificates")
	}
	return &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
	}}, nil
}

// Reexecuted at the daemon boundary, after the real cold script selected its
// environment. This is a real TLS client, not a Docker or native Actor proof.
func TestNativeBootstrapTrustDaemonTLSProcess(t *testing.T) {
	endpoints := os.Getenv("FACTORY_BOOTSTRAP_TRUST_TEST_ENDPOINTS")
	if endpoints == "" {
		t.Skip("owned cold-script subprocess only")
	}
	client, err := bootstrapTrustClient(os.Getenv("SSL_CERT_FILE"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	for _, endpoint := range strings.Split(endpoints, " ") {
		response, err := client.Get(endpoint)
		if err != nil {
			t.Fatalf("daemon-selected SSL_CERT_FILE=%s: %v", os.Getenv("SSL_CERT_FILE"), err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatal("TLS manifest response was not HTTP 200")
		}
	}
}

func TestNativeBootstrapTrustColdScriptSelectsCombinedBundleBeforeDaemon(t *testing.T) {
	script, err := os.ReadFile("../../../deploy/substrate/rootless/runtime-child.sh")
	if os.IsNotExist(err) {
		if _, deploymentErr := os.Stat("../../../deploy/substrate"); os.IsNotExist(deploymentErr) {
			t.Skip("cold-script subprocess needs the full checkout; module-only fixtures still run the trust-helper TLS tests")
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	native, nativeCA := bootstrapTrustServer(t, "native roots")
	factory, factoryCA := bootstrapTrustServer(t, "frozen Factory CA")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	state := filepath.Join(directory, "home/rootless/persist/connector")
	if err := os.MkdirAll(state, 0700); err != nil {
		t.Fatal(err)
	}
	projection := filepath.Join(directory, "native.pem")
	frozen := filepath.Join(directory, "factory.pem")
	write := func(path, text string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(projection, string(nativeCA), 0444)
	write(frozen, string(factoryCA), 0444)
	trace := filepath.Join(directory, "trace")
	helper := filepath.Join(directory, "factory-runtime-connector")
	// Substitute only fixed infrastructure operations and relocate the fixed
	// Actor paths into this test's private directory. No real mount/daemon runs.
	write(helper, `#!/bin/sh
set -eu
printf '%s\n' "$1" >> "$FIXTURE_TRACE"
case "$1" in
  native-source-restore) test "$FIXTURE_RESTORE" = ok ;;
  native-bootstrap-mode)
    cat "$FIXTURE_NATIVE" "$FIXTURE_FACTORY" > "$FIXTURE_STATE/trust.pem"
    chmod 0600 "$FIXTURE_STATE/trust.pem"
    echo "$FIXTURE_MODE" ;;
  native-parent) test "$FIXTURE_MODE" = input-stop ;;
  *) exit 92 ;;
esac
`, 0755)
	for _, name := range []string{"mount", "tinyproxy"} {
		write(filepath.Join(directory, name), "#!/bin/sh\nexit 0\n", 0755)
	}
	write(filepath.Join(directory, "stat"), "#!/bin/sh\nprintf '0:0:700\\n'\n", 0755)
	write(filepath.Join(directory, "dockerd"), `#!/bin/sh
set -eu
echo dockerd >> "$FIXTURE_TRACE"
exec "$FIXTURE_TEST_BINARY" -test.run='^TestNativeBootstrapTrustDaemonTLSProcess$' -test.v
`, 0755)
	scriptPath := filepath.Join(directory, "runtime-child.sh")
	write(scriptPath, strings.NewReplacer(
		"/usr/local/bin/factory-runtime-connector", helper,
		"/home/rootless", filepath.Join(directory, "home/rootless"),
	).Replace(string(script)), 0700)
	run := func(mode, restore string) ([]byte, error) {
		t.Helper()
		write(trace, "", 0600)
		command := exec.CommandContext(t.Context(), "/bin/sh", scriptPath)
		command.Env = []string{
			"PATH=" + directory + ":/usr/bin:/bin", "GOMAXPROCS=2", "DOCKER_HOST=unix:///run/user/1000/docker.sock",
			"SSL_CERT_FILE=" + projection, "FIXTURE_NATIVE=" + projection, "FIXTURE_FACTORY=" + frozen,
			"FIXTURE_STATE=" + state, "FIXTURE_TRACE=" + trace, "FIXTURE_MODE=" + mode,
			"FIXTURE_RESTORE=" + restore, "FIXTURE_TEST_BINARY=" + binary,
			"FACTORY_BOOTSTRAP_TRUST_TEST_ENDPOINTS=" + native.URL + " " + factory.URL,
		}
		return command.CombinedOutput()
	}
	for _, scenario := range []struct{ mode, restore, calls string }{
		{"input-stop", "ok", "native-source-restore\nnative-bootstrap-mode\nnative-parent\n"},
		{"unconfirmed", "ok", "native-source-restore\nnative-bootstrap-mode\n"},
		{"docker", "denied", "native-source-restore\n"},
		{"docker", "ok", "native-source-restore\nnative-bootstrap-mode\ndockerd\n"},
	} {
		t.Run(scenario.mode+"/"+scenario.restore, func(t *testing.T) {
			output, err := run(scenario.mode, scenario.restore)
			if (scenario.mode == "input-stop" || scenario.mode == "docker" && scenario.restore == "ok") != (err == nil) {
				t.Fatalf("cold script: %v\n%s", err, output)
			}
			calls, readErr := os.ReadFile(trace)
			if readErr != nil || string(calls) != scenario.calls {
				t.Fatalf("cold script crossed admission/Docker boundary: %s %v", calls, readErr)
			}
			if scenario.mode == "input-stop" {
				if _, err := os.Stat(filepath.Join(directory, "home/rootless/persist/docker")); !os.IsNotExist(err) {
					t.Fatal("input Stop created Docker storage")
				}
			}
		})
	}
}
