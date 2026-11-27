package procutil

import (
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
)

type EnvironmentVariable struct {
	Name         string `json:"name"`
	Value        string `json:"value"`
	Runtime      bool   `json:"runtime"`
	Verification bool   `json:"verification"`
}

type EnvironmentBundle struct {
	Variables []EnvironmentVariable `json:"variables"`
}

type RuntimeEnvironment struct {
	Version uint64            `json:"version"`
	Bundle  EnvironmentBundle `json:"bundle"`
}

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

func ValidateEnvironmentName(name string) bool {
	if !environmentName.MatchString(name) {
		return false
	}
	for _, prefix := range []string{"FACTORY_", "CODER_", "KUBERNETES_", "DOCKER_", "BAO_", "VAULT_"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	for _, reserved := range []string{"PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "BASH_ENV", "ENV", "SHELL", "IFS", "CDPATH", "ENV_SUPATH"} {
		if name == reserved {
			return false
		}
	}
	return true
}

// ValidateRuntimeValues checks child values arriving on the private stdin
// channel, never in the saved assignment.
func ValidateRuntimeValues(values map[string]string) error {
	if len(values) > 128 {
		return errors.New("Invalid Connector child environment")
	}
	for name, value := range values {
		if !ValidateEnvironmentName(name) || len(value) > 65536 || strings.ContainsRune(value, 0) {
			return errors.New("Invalid Connector child environment")
		}
	}
	return nil
}

func (environment RuntimeEnvironment) Validate(version uint64) error {
	invalid := errors.New("Runtime environment configuration is invalid")
	if environment.Version != version || len(environment.Bundle.Variables) > 128 {
		return invalid
	}
	names := map[string]bool{}
	for _, variable := range environment.Bundle.Variables {
		if !ValidateEnvironmentName(variable.Name) || names[variable.Name] || len(variable.Value) > 65536 || strings.ContainsRune(variable.Value, 0) {
			return invalid
		}
		names[variable.Name] = true
	}
	return nil
}

func RetryRuntimeEnvironmentRead(err error) bool {
	var untrusted x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var certificate x509.CertificateInvalidError
	if errors.As(err, &untrusted) || errors.As(err, &hostname) || errors.As(err, &certificate) {
		return false
	}
	var lookup *net.DNSError
	if errors.As(err, &lookup) {
		// Native egress denial is NXDOMAIN, not permission to try another host.
		return !lookup.IsNotFound && (lookup.IsTemporary || lookup.IsTimeout)
	}
	var request *url.Error
	if errors.As(err, &request) {
		// Tinyproxy can report temporary DNS failures as a CONNECT reason phrase.
		switch request.Err.Error() {
		case "Unable to connect", http.StatusText(http.StatusInternalServerError), http.StatusText(http.StatusBadGateway),
			http.StatusText(http.StatusServiceUnavailable), http.StatusText(http.StatusGatewayTimeout):
			return true
		}
	}
	var transient net.Error
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		(errors.As(err, &transient) && (transient.Timeout() || transient.Temporary()))
}

func AssignedEnvironment(base []string, values map[string]string) []string {
	result := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if _, replace := values[name]; !replace {
			result = append(result, entry)
		}
	}
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result
}
