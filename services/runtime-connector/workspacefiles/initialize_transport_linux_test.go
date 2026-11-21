package workspacefiles

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Only clone is faulted. All successful Git operations, including publication's
// revision and repository identity checks, use the installed Git executable.
func checkoutTransportGit(t *testing.T, message string, failures int) (string, Initialization, func() int) {
	t.Helper()
	parent, intent := initializerFixture(t)
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	attempts := filepath.Join(directory, "attempts")
	arguments := filepath.Join(directory, "arguments")
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
	script := fmt.Sprintf(`#!/bin/sh
clone=false
for arg do
  if [ "$arg" = clone ]; then clone=true; fi
  target="$arg"
done
if [ "$clone" = true ]; then
  printf 'attempt\n' >> %s
  printf '%%s\000' "$@" >> %s
  count=$(wc -l < %s)
  if [ "$count" -le %d ]; then
    mkdir -p "$target/.git/objects/pack"
    printf 'incomplete private clone\n' > "$target/partial-transport"
    printf 'started\n' > %s
    printf '%%s\n' %s >&2
    exit 128
  fi
fi
exec %s "$@"
`, quote(attempts), quote(arguments), quote(attempts), failures, quote(filepath.Join(parent, "transport-started")), quote(message), quote(git))
	if err := os.WriteFile(filepath.Join(directory, "git"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+":/usr/bin:/bin")
	originalDelays := sourceConnectDelays
	sourceConnectDelays = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() { sourceConnectDelays = originalDelays })
	return parent, intent, func() int {
		content, err := os.ReadFile(attempts)
		if os.IsNotExist(err) {
			return 0
		}
		if err != nil {
			t.Fatal(err)
		}
		count := strings.Count(string(content), "attempt\n")
		args, err := os.ReadFile(arguments)
		if err != nil {
			t.Fatal(err)
		}
		observed := strings.Split(strings.TrimSuffix(string(args), "\x00"), "\x00")
		// initGit's fixed safety configuration plus exactly the original clone
		// request must be repeated, without changing URL or TLS/proxy settings.
		expected := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
			"-c", "core.logAllRefUpdates=false", "-c", "safe.directory=",
			"clone", "--no-checkout", "--no-hardlinks", "--", intent.RepositoryURL,
			filepath.Join(parent, ".factory-source-init-"+intent.WorkspaceID, "checkout")}
		for i := 0; i < count; i++ {
			if len(observed) < len(expected) || !reflect.DeepEqual(observed[:len(expected)], expected) {
				t.Fatal("retry changed the original clone request")
			}
			observed = observed[len(expected):]
		}
		if len(observed) != 0 {
			t.Fatal("unexpected clone arguments")
		}
		return count
	}
}

func TestSourceInitializationRetriesResetTransport(t *testing.T) {
	for _, fixture := range []struct{ name, message string }{
		{"openssl-read-reset", "fatal: unable to access 'https://forge.factory.invalid/project.git/': OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 104"},
		{"curl-recv-reset", "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: expected flush after ref listing"},
		{"existing-connect-retry", "fatal: unable to access 'https://forge.factory.invalid/project.git/': Failed to connect to forge.factory.invalid port 443: Connection refused"},
		{"native-proxy-connect", "fatal: unable to access 'https://forge.factory.invalid/project.git/': CONNECT tunnel failed, response 500"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			parent, intent, calls := checkoutTransportGit(t, fixture.message, 1)
			if err := Initialize(context.Background(), parent, intent); err != nil {
				t.Fatal("valid initialization did not recover its private partial clone:", err)
			}
			if calls() != 2 {
				t.Fatal("initialization did not make exactly one transport retry")
			}
			canonical := filepath.Join(parent, "project")
			content, err := os.ReadFile(filepath.Join(canonical, "source.txt"))
			if err != nil || string(content) != "original" {
				t.Fatal("the intended source was not published", err)
			}
			if _, err := os.Lstat(filepath.Join(canonical, "partial-transport")); !os.IsNotExist(err) {
				t.Fatal("failed clone content was published")
			}
			if err := os.WriteFile(filepath.Join(canonical, "source.txt"), []byte("retained human edit"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := Initialize(context.Background(), parent, intent); err != nil || calls() != 2 {
				t.Fatal("recovery cloned over retained source", err)
			}
			content, err = os.ReadFile(filepath.Join(canonical, "source.txt"))
			if err != nil || string(content) != "retained human edit" {
				t.Fatal("recovery changed retained human source", err)
			}
		})
	}
}

func TestSourceInitializationDoesNotRetryPermanentSSLOrDenial(t *testing.T) {
	for _, fixture := range []struct{ name, message string }{
		{"generic-ssl", "SSL connection error"},
		{"unspecified-syscall", "OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 0"},
		{"untrusted-certificate", "SSL certificate problem: unable to get local issuer certificate"},
		{"hostname", "SSL: no alternative certificate subject name matches target hostname"},
		{"missing-ca", "error setting certificate verify locations: CAfile: /missing/ca.pem"},
		{"peer-verification", "SSL peer certificate or SSH remote key was not OK"},
		{"tls-alert", "OpenSSL SSL_connect: SSL_ERROR_SSL: tlsv1 alert unknown ca"},
		{"authentication", "fatal: Authentication failed for 'https://forge.factory.invalid/project.git/'"},
		{"http-401", "fatal: unable to access remote: The requested URL returned error: 401"},
		{"http-403", "fatal: unable to access remote: The requested URL returned error: 403"},
		{"proxy-auth", "fatal: CONNECT tunnel failed, response 407"},
		{"permission", "fatal: Permission denied"},
		{"egress-reset", "fatal: egress policy denied: Connection reset by peer"},
		{"certificate-reset", "fatal: SSL certificate problem: Connection reset by peer"},
		{"auth-reset", "fatal: Authentication failed\nRecv failure: Connection reset by peer"},
		{"proxy-denial-reset", "fatal: CONNECT tunnel failed, response 403\nRecv failure: Connection reset by peer"},
		{"proxy-connect-policy", "CONNECT tunnel failed, response 500\nPermission denied"},
		{"proxy-connect-trust", "CONNECT tunnel failed, response 500\nSSL certificate problem"},
		{"protocol-reset", "OpenSSL SSL_read: SSL_ERROR_SSL\nRecv failure: Connection reset by peer"},
		{"connect-certificate", "Failed to connect: SSL certificate problem"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			parent, intent, calls := checkoutTransportGit(t, fixture.message, 100)
			err := Initialize(context.Background(), parent, intent)
			var transient *transientSourceError
			if err == nil || errors.As(err, &transient) || calls() != 1 {
				t.Fatal("permanent SSL/authority failure was retried or accepted", err)
			}
			if strings.Contains(err.Error(), "https://") || strings.Contains(err.Error(), "/missing/") {
				t.Fatal("Git transport diagnostics disclosed raw arguments")
			}
			if _, err := os.Lstat(filepath.Join(parent, "project")); !os.IsNotExist(err) {
				t.Fatal("failed clone became canonical")
			}
		})
	}
}

func TestSourceInitializationResetExhaustionDoesNotPublish(t *testing.T) {
	parent, intent, calls := checkoutTransportGit(t, "OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 104", 100)
	err := Initialize(context.Background(), parent, intent)
	var transient *transientSourceError
	if !errors.As(err, &transient) || calls() != len(sourceConnectDelays)+1 {
		t.Fatal("reset retries did not exhaust the existing bounded schedule", err)
	}
	if _, err := os.Lstat(filepath.Join(parent, "project")); !os.IsNotExist(err) {
		t.Fatal("exhausted clone became canonical")
	}
}

func TestSourceInitializationReportsCredentialFreeTransportCategories(t *testing.T) {
	for _, fixture := range []struct {
		name, message, category string
		transient               bool
	}{
		{"certificate", "SSL certificate problem: unable to get local issuer certificate", "TLS verification", false},
		{"hostname", "SSL: no alternative certificate subject name matches target hostname", "TLS verification", false},
		{"trust", "OpenSSL SSL_connect: tlsv1 alert unknown ca", "TLS verification", false},
		{"ca-file", "error setting certificate verify locations: CAfile: /private/ca.pem", "TLS verification", false},
		{"reset", "OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 104", "connection reset", true},
		{"proxy-connect", "CONNECT tunnel failed, response 500", "proxy connection unavailable", true},
		{"unknown-ssl", "SSL connection error", "SSL", false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			// Synthetic stderr detail must never appear in the returned category.
			message := "fatal: unable to access 'https://fixture:DO_NOT_LOG@forge.factory.invalid/PRIVATE_DETAIL': " + fixture.message
			parent, intent, calls := checkoutTransportGit(t, message, 100)
			err := Initialize(context.Background(), parent, intent)
			if err == nil || err.Error() != "source checkout preparation failed: "+fixture.category {
				t.Fatal("initializer did not return the expected fixed diagnostic category")
			}
			var transient *transientSourceError
			if errors.As(err, &transient) != fixture.transient {
				t.Fatal("diagnostic category changed retry eligibility")
			}
			expected := 1
			if fixture.transient {
				expected += len(sourceConnectDelays)
			}
			if calls() != expected {
				t.Fatal("diagnostic classification changed bounded clone attempts")
			}
		})
	}
}

func TestSourceInitializationResetWaitHonorsCancellation(t *testing.T) {
	parent, intent, calls := checkoutTransportGit(t, "Recv failure: Connection reset by peer", 100)
	sourceConnectDelays = []time.Duration{time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := filepath.Join(parent, "transport-started")
	done := make(chan error, 1)
	go func() { done <- Initialize(ctx, parent, intent) }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatal("initialization returned before the transport probe", err)
		case <-deadline.C:
			t.Fatal("fake Git did not start")
		case <-ticker.C:
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || calls() != 1 {
			t.Fatal("cancellation did not stop the original clone attempt", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled transport retry did not settle")
	}
	if _, err := os.Lstat(filepath.Join(parent, "project")); !os.IsNotExist(err) {
		t.Fatal("canceled clone became canonical")
	}
}
