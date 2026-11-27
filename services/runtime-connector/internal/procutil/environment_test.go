package procutil

import (
	"context"
	"crypto/x509"
	"io"
	"net"
	"net/url"
	"strings"
	"testing"
)

func TestChildRuntimeEnvironmentRejectsInfrastructureOverrides(t *testing.T) {
	for _, name := range []string{"DOCKER_CONFIG", "FACTORY_TOKEN", "HOME", "NODE_OPTIONS", "../PATH"} {
		if ValidateRuntimeValues(map[string]string{name: "owned"}) == nil {
			t.Fatal("reserved child value admitted")
		}
	}
	if ValidateRuntimeValues(map[string]string{"APP_TOKEN": "owned\nvalue"}) != nil {
		t.Fatal("multiline value rejected")
	}
}

func TestRuntimeEnvironmentKeepsExactVersionBounds(t *testing.T) {
	valid := RuntimeEnvironment{Version: 7, Bundle: EnvironmentBundle{Variables: []EnvironmentVariable{
		{Name: "APP_TOKEN", Value: "owned-secret\nvalue", Runtime: true, Verification: false},
	}}}
	if err := valid.Validate(7); err != nil {
		t.Fatal(err)
	}
	if valid.Validate(8) == nil {
		t.Fatal("another Environment version was admitted")
	}
	for _, variable := range []EnvironmentVariable{
		{Name: "HOME", Value: "owned"},
		{Name: "APP_TOKEN", Value: "invalid\x00value"},
		{Name: "APP_TOKEN", Value: strings.Repeat("x", 65537)},
	} {
		current := RuntimeEnvironment{Version: 7, Bundle: EnvironmentBundle{Variables: []EnvironmentVariable{variable}}}
		if current.Validate(7) == nil {
			t.Fatal("invalid protected Environment value was admitted")
		}
	}
	duplicate := valid
	duplicate.Bundle.Variables = append(append([]EnvironmentVariable{}, valid.Bundle.Variables...), valid.Bundle.Variables[0])
	if duplicate.Validate(7) == nil {
		t.Fatal("duplicate protected Environment names were admitted")
	}
	oversized := valid
	oversized.Bundle.Variables = make([]EnvironmentVariable, 129)
	if oversized.Validate(7) == nil {
		t.Fatal("oversized Environment was admitted")
	}
}

func TestAssignedEnvironmentReplacesInheritedValues(t *testing.T) {
	result := AssignedEnvironment([]string{"API_KEY=old", "HOME=/home/node"}, map[string]string{"API_KEY": "new\nvalue"})
	if len(result) != 2 || result[0] != "HOME=/home/node" || result[1] != "API_KEY=new\nvalue" {
		t.Fatalf("unexpected env %v", result)
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
			if RetryRuntimeEnvironmentRead(&url.Error{Op: "Get", Err: scenario.err}) != scenario.retry {
				t.Fatal("environment read retry classification changed")
			}
		})
	}
}
