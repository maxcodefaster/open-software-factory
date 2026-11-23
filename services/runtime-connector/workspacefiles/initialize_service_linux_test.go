package workspacefiles

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceInitializationServiceAuthIsExplicitCloneOnlyTransport(t *testing.T) {
	directory := t.TempDir()
	script := `#!/bin/sh
/usr/bin/env -0 > "$0.environment"
printf '%s\000' "$@" > "$0.arguments"
printf '%s\n' "$GIT_CONFIG_VALUE_0" >&2
exit 128
`
	git := filepath.Join(directory, "git")
	if err := os.WriteFile(git, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+":/usr/bin:/bin")
	for name, value := range map[string]string{
		"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "http.extraHeader", "GIT_CONFIG_VALUE_0": "Authorization: Basic AMBIENT",
		"GIT_CONFIG_KEY_1": "core.hooksPath", "GIT_CONFIG_VALUE_1": "/untrusted/hooks",
		"GIT_CONFIG_PARAMETERS": "'core.hooksPath=/untrusted/hooks'", "GIT_CONFIG_SYSTEM": "/untrusted/system",
		"GIT_CONFIG_GLOBAL": "/untrusted/global", "GIT_TEMPLATE_DIR": "/untrusted/template",
		"GIT_ASKPASS": "/untrusted/askpass", "GIT_SSL_NO_VERIFY": "true", "FACTORY_CONNECTOR_TOKEN": "private-parent",
		"HTTP_PROXY": "http://127.0.0.1:8000", "HTTPS_PROXY": "http://127.0.0.1:8001", "NO_PROXY": "localhost",
		"http_proxy": "http://127.0.0.1:8002", "https_proxy": "http://127.0.0.1:8003", "no_proxy": "127.0.0.1",
		"GIT_SSL_CAINFO": "/owned/ca.pem", "GIT_SSL_CAPATH": "/owned/certificates",
	} {
		t.Setenv(name, value)
	}
	const repositoryURL = "https://forge.factory.invalid/owned.git"
	const authorization = "Basic ZmFjdG9yeTpDT05GSURFTlRJQUw="
	service := context.WithValue(t.Context(), serviceCloneTransportKey{}, serviceCloneTransport{repositoryURL, authorization})
	for _, operation := range []struct {
		name string
		ctx  context.Context
		args []string
		auth bool
	}{
		{"actor-clone", t.Context(), []string{"clone", "--no-checkout", "--no-hardlinks", "--", repositoryURL, "/owned/staging"}, false},
		{"service-clone", service, []string{"clone", "--no-checkout", "--no-hardlinks", "--", repositoryURL, "/owned/staging"}, true},
		{"service-local-config", service, []string{"config", "--local", "--get", "factory.repositoryIdentity"}, false},
		{"service-checkout", service, []string{"checkout", "--detach", strings.Repeat("a", 40)}, false},
	} {
		t.Run(operation.name, func(t *testing.T) {
			if _, err := initGit(operation.ctx, "", operation.args...); err == nil || err.Error() != "source checkout preparation failed" {
				t.Fatal("Git failure leaked clone credentials or raw diagnostics")
			}
			encoded, err := os.ReadFile(git + ".environment")
			if err != nil {
				t.Fatal(err)
			}
			environment := make(map[string]string)
			for _, entry := range strings.Split(string(encoded), "\x00") {
				name, value, ok := strings.Cut(entry, "=")
				if ok {
					environment[name] = value
				}
			}
			for _, name := range []string{"GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
				"GIT_TEMPLATE_DIR", "GIT_ASKPASS", "GIT_SSL_NO_VERIFY", "FACTORY_CONNECTOR_TOKEN"} {
				if _, ok := environment[name]; ok {
					t.Errorf("Git inherited ambient authority %s", name)
				}
			}
			for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH"} {
				if environment[name] != os.Getenv(name) {
					t.Errorf("Git lost its narrow transport inheritance: %s", name)
				}
			}
			if environment["GIT_CONFIG_NOSYSTEM"] != "1" || environment["GIT_CONFIG_GLOBAL"] != "/dev/null" ||
				environment["GIT_TERMINAL_PROMPT"] != "0" {
				t.Fatal("Git lost its existing initialization safety environment")
			}
			if operation.auth {
				if environment["GIT_CONFIG_COUNT"] != "1" || environment["GIT_CONFIG_KEY_0"] != "http."+repositoryURL+".extraHeader" ||
					environment["GIT_CONFIG_VALUE_0"] != "Authorization: "+authorization {
					t.Fatal("clone did not receive exactly its explicit URL-scoped transport")
				}
			} else if environment["GIT_CONFIG_COUNT"] != "" || environment["GIT_CONFIG_KEY_0"] != "" || environment["GIT_CONFIG_VALUE_0"] != "" {
				t.Fatal("Actor or non-clone Git received service authorization")
			}
			arguments, err := os.ReadFile(git + ".arguments")
			if err != nil || strings.Contains(string(arguments), authorization) || strings.Contains(string(arguments), "Authorization:") {
				t.Fatal("Git authorization escaped into subprocess arguments")
			}
		})
	}
}
