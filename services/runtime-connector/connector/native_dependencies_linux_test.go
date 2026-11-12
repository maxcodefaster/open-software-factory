//go:build linux

package connector

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeDependencyTransportKeepsTrustAndUpgradesOnlyAPTRecipes(t *testing.T) {
	root := t.TempDir()
	apt := filepath.Join(root, "etc/apt/sources.list.d")
	if err := os.MkdirAll(apt, 0700); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(root, "etc/ssl/certs/ca-certificates.crt")
	if err := os.MkdirAll(filepath.Dir(ca), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ca, []byte("retained-public-root"), 0644); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{
		"debian.sources": "Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n",
		"private.list":   "deb [signed-by=/owned/keyring.gpg] https://packages.example/stable main\n",
	} {
		if err := os.WriteFile(filepath.Join(apt, name), []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	script := filepath.Join(root, "transport.sh")
	trust := filepath.Join(root, "trust.pem")
	public := "-----BEGIN CERTIFICATE-----\npublic-only\n-----END CERTIFICATE-----\n"
	if err := os.WriteFile(script, nativeDependencyTransport, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(trust, []byte(public), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("sh", script, root, trust).CombinedOutput(); err != nil {
		t.Fatalf("transport: %v: %s", err, output)
	}
	bundle, _ := os.ReadFile(ca)
	if string(bundle) != "retained-public-root\n"+public {
		t.Fatal("native trust replaced existing roots or concatenated invalid PEM boundaries")
	}
	local, _ := os.ReadFile(filepath.Join(root, "usr/local/share/ca-certificates/factory-native-transport-001.crt"))
	if string(local) != public {
		t.Fatal("installing ca-certificates during a Feature could erase the native trust")
	}
	sources, _ := os.ReadFile(filepath.Join(apt, "debian.sources"))
	if strings.Contains(string(sources), "http://") || !strings.Contains(string(sources), "https://deb.debian.org/debian") || !strings.Contains(string(sources), "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg") {
		t.Fatal("APT TLS preparation changed repository identity or signature policy")
	}
	private, _ := os.ReadFile(filepath.Join(apt, "private.list"))
	if string(private) != "deb [signed-by=/owned/keyring.gpg] https://packages.example/stable main\n" {
		t.Fatal("an already secure repository changed")
	}
	if err := os.WriteFile(trust, []byte(public+"-----BEGIN PRIVATE KEY-----\nsecret"), 0600); err != nil {
		t.Fatal(err)
	}
	if exec.Command("sh", script, root, trust).Run() == nil {
		t.Fatal("a private key entered a dependency image")
	}
	after, _ := os.ReadFile(ca)
	if string(after) != string(bundle) {
		t.Fatal("rejected trust changed the retained bundle")
	}
	if exec.Command("sh", script).Run() == nil {
		t.Fatal("the script can run without an explicit image/test root")
	}
}

const nativeDependencyDockerFixture = `#!/bin/sh
printf '%s\n' "$*" >>"$NATIVE_DEPENDENCY_FIXTURE/trace"
case "$1 $2" in
  "image ls") if [ "$NATIVE_DEPENDENCY_SCENARIO" = foreign ]; then printf 'sha256:foreign'; fi ;;
  "image inspect")
    case "$4" in
      *Config.User*) printf '"node"' ;;
      *RepoDigests*) printf '["%s"]' "$NATIVE_DEPENDENCY_BASE" ;;
      "{{index .Config.Labels "*) awk '{print $2}' "$NATIVE_DEPENDENCY_FIXTURE/outcome" ;;
      *) test -f "$NATIVE_DEPENDENCY_FIXTURE/outcome" && cat "$NATIVE_DEPENDENCY_FIXTURE/outcome" ;;
    esac ;;
  "compose --file") printf '{"services":{"app":{"image":"%s"}}}' "$NATIVE_DEPENDENCY_BASE" ;;
  "build "*)
    for arg in "$@"; do
      case "$arg" in factory.dev/native-dependencies=*) identity="${arg#*=}" ;; esac
      directory=$arg
    done
    test -n "$identity" || exit 8
    cp "$directory/Dockerfile" "$NATIVE_DEPENDENCY_FIXTURE/Dockerfile"
    cp "$directory/trust.pem" "$NATIVE_DEPENDENCY_FIXTURE/trust.pem"
    cp "$directory/transport.sh" "$NATIVE_DEPENDENCY_FIXTURE/transport.sh"
    if [ "$NATIVE_DEPENDENCY_SCENARIO" = missing ]; then exit 1; fi
    if [ "$NATIVE_DEPENDENCY_SCENARIO" = wrong-label ]; then identity=another-owner; fi
    printf '%s %s' "$NATIVE_DEPENDENCY_IMAGE" "$identity" >"$NATIVE_DEPENDENCY_FIXTURE/outcome"
    if [ "$NATIVE_DEPENDENCY_SCENARIO" = lost-output ]; then exit 1; fi ;;
  *) exit 9 ;;
esac
`

func nativeDependencyFixture(t *testing.T, scenario string) (Assignment, string) {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(nativeDependencyDockerFixture), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NATIVE_DEPENDENCY_FIXTURE", directory)
	t.Setenv("NATIVE_DEPENDENCY_SCENARIO", scenario)
	t.Setenv("NATIVE_DEPENDENCY_BASE", projectImage("a"))
	t.Setenv("NATIVE_DEPENDENCY_IMAGE", "sha256:"+strings.Repeat("b", 64))
	assignment := validAssignment()
	assignment.ConnectorStateDir = t.TempDir()
	assignment.nativeActorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
	return assignment, directory
}

func TestNativeDependencyBuildIsNetworklessOwnedAndNeverReplaysLostOutcomes(t *testing.T) {
	for _, scenario := range []string{"created", "lost-output", "missing", "wrong-label", "foreign"} {
		t.Run(scenario, func(t *testing.T) {
			assignment, directory := nativeDependencyFixture(t, scenario)
			assignment.RuntimeEnvironment = map[string]string{"PRIVATE_TOKEN": "never-build-this"}
			for attempt := 0; attempt < 2; attempt++ {
				image, err := nativeDependencyImage(context.Background(), assignment, projectImage("a"), []byte("public-native-trust"))
				if healthy := scenario == "created" || scenario == "lost-output"; healthy != (err == nil) {
					t.Fatalf("native dependency ownership: %v", err)
				}
				if err == nil && image != "sha256:"+strings.Repeat("b", 64) {
					t.Fatal("native dependency image identity changed")
				}
			}
			trace, _ := os.ReadFile(filepath.Join(directory, "trace"))
			builds := strings.Count(string(trace), "\nbuild ")
			if scenario == "foreign" {
				if builds != 0 {
					t.Fatal("a foreign tag was adopted or rebuilt")
				}
				return
			}
			if builds != 1 || !strings.Contains(string(trace), "build --network=none --pull=false") {
				t.Fatalf("native build was repeated or used networking: %s", trace)
			}
			dockerfile, _ := os.ReadFile(filepath.Join(directory, "Dockerfile"))
			if !strings.HasPrefix(string(dockerfile), "FROM "+projectImage("a")+"\n") || !strings.HasSuffix(string(dockerfile), "USER node\n") {
				t.Fatal("base image or declared user changed")
			}
			for _, forbidden := range []string{"never-build-this", "PRIVATE_TOKEN", "docker.sock", "--privileged", "insecure", "verify=false"} {
				if strings.Contains(string(dockerfile)+string(trace), forbidden) {
					t.Fatalf("native dependency build crossed its boundary: %s", forbidden)
				}
			}
			markers, _ := filepath.Glob(filepath.Join(assignment.ConnectorStateDir, "*.intended"))
			if len(markers) != 1 {
				t.Fatal("immutable creation intent is missing")
			}
			if err := os.WriteFile(markers[0], []byte("foreign"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := nativeDependencyImage(context.Background(), assignment, projectImage("a"), []byte("public-native-trust")); err == nil {
				t.Fatal("changed native build intent was accepted")
			}
		})
	}
}

func TestNativeDockerProxyPreservesPrivateAuthenticationWithoutExportingIt(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "config.json")
	if err := os.WriteFile(file, []byte(`{"auths":{"registry.example":{"auth":"private-registry-token"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := nativeDockerProxy(environmentFiles{dockerConfig: directory}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(file)
	var config struct {
		Auths   map[string]map[string]string `json:"auths"`
		Proxies map[string]map[string]string `json:"proxies"`
	}
	if json.Unmarshal(data, &config) != nil || config.Auths["registry.example"]["auth"] != "private-registry-token" || config.Proxies["default"]["httpsProxy"] != "http://172.17.0.1:8888" {
		t.Fatal("native Docker proxy changed private authentication or its Actor-private address")
	}
	assignment := validAssignment()
	if len(nativeDependencyRemoteEnvironment(assignment, "")) != 0 {
		t.Fatal("legacy startup acquired native transport")
	}
	assignment.nativeActorUID = "original-actor"
	args := strings.Join(nativeDependencyRemoteEnvironment(assignment, "http://172.18.0.1:8888"), " ")
	for _, required := range []string{"--remote-env NODE_EXTRA_CA_CERTS=" + nativeDependencyCA, "--remote-env SSL_CERT_FILE=" + nativeDependencyCA, "--remote-env http_proxy=http://172.18.0.1:8888"} {
		if !strings.Contains(args, required) {
			t.Fatalf("lifecycle hooks lack native transport: %s", required)
		}
	}
	if strings.Contains(args, "private-registry-token") || strings.Contains(args, "ACTOR_UID") {
		t.Fatal("native lifecycle hooks received infrastructure credentials or identity")
	}
}

func TestNativeDependencyOverlayRetainsFeaturesHooksAndOriginalComposeSource(t *testing.T) {
	assignment, directory := nativeDependencyFixture(t, "created")
	assignment.WorkspaceFolder = t.TempDir()
	assignment.DevcontainerPath = ".devcontainer/devcontainer.json"
	configDirectory := filepath.Join(assignment.WorkspaceFolder, ".devcontainer")
	if err := os.Mkdir(configDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	config := `{"dockerComposeFile":"compose.yaml","service":"app","remoteUser":"node","features":{"ghcr.io/devcontainers/features/git@sha256:fd75977de13a9979000e0e78baf949adb0ca71d2398995fa22e0a36d7e7e7fe2":{"version":"os-provided"}},"postCreateCommand":"npm ci && npm run db:migrate"}`
	compose := "services:\n  app:\n    image: " + projectImage("a") + "\n    cap_drop: [ALL]\n    volumes: [..:/workspace/project]\n  postgres:\n    image: " + projectImage("c") + "\n    volumes: [private-data:/var/lib/postgresql/data]\nvolumes:\n  private-data:\n"
	for name, text := range map[string]string{"devcontainer.json": config, "compose.yaml": compose} {
		if err := os.WriteFile(filepath.Join(configDirectory, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	resolved, _ := json.Marshal(map[string]json.RawMessage{"configuration": json.RawMessage(config)})
	if err := os.WriteFile(filepath.Join(directory, "resolved.json"), resolved, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte("#!/bin/sh\n[ \"$1\" = read-configuration ] || exit 1\ncat \"$NATIVE_DEPENDENCY_FIXTURE/resolved.json\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	assignment.RegistryCAFile = filepath.Join(directory, "public-ca.pem")
	if err := os.WriteFile(assignment.RegistryCAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	path, image, cleanup, err := prepareNativeDependencies(context.Background(), &assignment)
	defer cleanup()
	if err != nil {
		t.Fatal(err)
	}
	if image != "sha256:"+strings.Repeat("b", 64) {
		t.Fatal("generated overlay selected another local image")
	}
	assignment.preparedRootFSImage = image
	if err := requireNativeDependencyReference(context.Background(), assignment); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var overlay map[string]json.RawMessage
	var original map[string]json.RawMessage
	if json.Unmarshal(data, &overlay) != nil || json.Unmarshal([]byte(config), &original) != nil {
		t.Fatal("generated overlay is invalid")
	}
	for _, key := range []string{"features", "postCreateCommand", "remoteUser"} {
		var left, right any
		_ = json.Unmarshal(overlay[key], &left)
		_ = json.Unmarshal(original[key], &right)
		l, _ := json.Marshal(left)
		r, _ := json.Marshal(right)
		if string(l) != string(r) {
			t.Fatalf("native dependency preparation removed or changed required %s", key)
		}
	}
	var files []string
	originalCompose, err := filepath.EvalSymlinks(filepath.Join(configDirectory, "compose.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(overlay["dockerComposeFile"], &files) != nil || len(files) != 2 || files[0] != originalCompose {
		t.Fatal("native overlay replaced original Compose data or dependencies")
	}
	consumer, _ := os.ReadFile(files[1])
	if !strings.Contains(string(consumer), assignment.nativeDependencyReference) || strings.Contains(string(consumer), "sha256:") {
		t.Fatal("Feature builds received an image ID that BuildKit would interpret as a registry repository")
	}
	registry, found, err := assignment.registryProjectImages([]string{assignment.nativeDependencyReference, projectImage("c")})
	if err != nil || !found || len(registry) != 1 || registry[0] != projectImage("c") {
		t.Fatal("the internal local reference was pulled or displaced another registry dependency")
	}
	encoded, _ := json.Marshal(assignment)
	if strings.Contains(string(encoded), assignment.nativeDependencyReference) {
		t.Fatal("Source can supply native local-reference authority")
	}
	traceBefore, _ := os.ReadFile(filepath.Join(directory, "trace"))
	outcome, _ := os.ReadFile(filepath.Join(directory, "outcome"))
	if err := os.WriteFile(filepath.Join(directory, "outcome"), []byte(strings.Replace(string(outcome), strings.Repeat("b", 64), strings.Repeat("c", 64), 1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := startDevcontainer(context.Background(), assignment); err == nil || !errors.Is(err, errDevcontainerNotStarted) {
		t.Fatal("a retagged native dependency reached container startup or cleanup")
	}
	traceAfter, _ := os.ReadFile(filepath.Join(directory, "trace"))
	if strings.Contains(string(traceAfter[len(traceBefore):]), "compose ") || strings.Contains(string(traceAfter[len(traceBefore):]), "ps ") {
		t.Fatal("changed native image identity permitted lifecycle side effects")
	}
	for name, expected := range map[string]string{"devcontainer.json": config, "compose.yaml": compose} {
		actual, _ := os.ReadFile(filepath.Join(configDirectory, name))
		if string(actual) != expected {
			t.Fatalf("native preparation mutated canonical Source: %s", name)
		}
	}
	assignment.nativeActorUID = "another-actor"
	if _, _, remove, err := prepareNativeDependencies(context.Background(), &assignment); err == nil {
		remove()
		t.Fatal("changed native Actor identity was accepted")
	}
}
