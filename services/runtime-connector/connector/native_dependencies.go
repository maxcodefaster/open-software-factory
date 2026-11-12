package connector

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed native-dependency-transport.sh
var nativeDependencyTransport []byte

const nativeDependencyLabel = "factory.dev/native-dependencies"
const nativeDependencyCA = "/etc/ssl/certs/ca-certificates.crt"

// Supplement an image-only primary before Features and lifecycle hooks, without
// changing Source or letting a build read Parent credentials. Other recipes
// retain their authored Dockerfile and the existing confinement checks.
func prepareNativeDependencies(ctx context.Context, assignment *Assignment) (string, string, func(), error) {
	noop := func() {}
	if assignment.nativeActorUID == "" {
		return "", "", noop, nil
	}
	if assignment.nativeActorUID != os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID") {
		return "", "", noop, errors.New("native dependency Actor identity changed")
	}
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	command := exec.CommandContext(ctx, "devcontainer", "read-configuration", "--workspace-folder", assignment.WorkspaceFolder, "--config", configPath, "--log-format", "json")
	command.Env = devcontainerEnvironment(*assignment)
	output, err := command.Output()
	var source json.RawMessage
	for _, line := range strings.Split(string(output), "\n") {
		var result struct {
			Configuration json.RawMessage `json:"configuration"`
		}
		if json.Unmarshal([]byte(line), &result) == nil && len(result.Configuration) != 0 {
			source = result.Configuration
		}
	}
	var config map[string]json.RawMessage
	if err != nil || len(output) > 1<<20 || json.Unmarshal(source, &config) != nil || config == nil {
		return "", "", noop, errors.New("native dependency configuration is unavailable")
	}
	var base string
	if config["dockerComposeFile"] != nil {
		var declaration any
		var service string
		if json.Unmarshal(config["dockerComposeFile"], &declaration) != nil || json.Unmarshal(config["service"], &service) != nil || !composeServiceName.MatchString(service) {
			return "", "", noop, errors.New("native dependency primary is unavailable")
		}
		files, err := committedComposeFiles(assignment.WorkspaceFolder, configPath, declaration)
		if err != nil {
			return "", "", noop, err
		}
		args := []string{"compose"}
		for _, file := range files {
			args = append(args, "--file", file)
		}
		output, err := runtimeDockerCommand(ctx, append(args, "config", "--format", "json")...).Output()
		var model struct {
			Services map[string]struct {
				Image string          `json:"image"`
				Build json.RawMessage `json:"build"`
			} `json:"services"`
		}
		if err != nil || len(output) > 2<<20 || json.Unmarshal(output, &model) != nil {
			return "", "", noop, errors.New("native dependency Compose inputs are unavailable")
		}
		primary, ok := model.Services[service]
		if !ok {
			return "", "", noop, errors.New("native dependency primary is undeclared")
		}
		if len(primary.Build) != 0 && string(primary.Build) != "null" {
			return "", "", noop, nil
		}
		base = primary.Image
	} else if config["image"] == nil {
		return "", "", noop, nil
	} else if json.Unmarshal(config["image"], &base) != nil {
		return "", "", noop, errors.New("native dependency image is invalid")
	}
	// Acquisition has already passed normal image admission. Freeze even a mutable
	// authored reference to its actually downloaded immutable registry digest.
	base, err = resolveProjectImage(ctx, base)
	if err != nil {
		return "", "", noop, err
	}
	trust, err := os.ReadFile(assignment.RegistryCAFile)
	roots := x509.NewCertPool()
	if err != nil || len(trust) > 2<<20 || strings.Contains(string(trust), "PRIVATE KEY") || !roots.AppendCertsFromPEM(trust) {
		return "", "", noop, errors.New("native dependency trust is unavailable")
	}
	image, err := nativeDependencyImage(ctx, *assignment, base, trust)
	if err != nil {
		return "", "", noop, err
	}
	label, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{index .Config.Labels \""+nativeDependencyLabel+"\"}}", image).Output()
	identity := strings.TrimSpace(string(label))
	if err != nil || !regexpIdentity(identity) {
		return "", "", noop, errors.New("native dependency local reference is unavailable")
	}
	reference := "factory-native-dependencies:" + identity
	selection := *assignment
	selection.preparedRootFSImage = image
	selection.nativeDependencyReference = reference
	if err := requireNativeDependencyReference(ctx, selection); err != nil {
		return "", "", noop, err
	}
	directory, err := os.MkdirTemp("/dev/shm", "factory-native-dependencies-")
	if err != nil {
		return "", "", noop, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	if config["dockerComposeFile"] != nil {
		err = configureComposePrebuildConsumer(assignment.WorkspaceFolder, configPath, directory, reference, config)
	} else {
		config["image"], _ = json.Marshal(reference)
	}
	if err == nil {
		encoded, _ := json.Marshal(config)
		err = os.WriteFile(filepath.Join(directory, "devcontainer.json"), encoded, 0600)
	}
	if err != nil {
		cleanup()
		return "", "", noop, err
	}
	assignment.nativeDependencyReference = reference
	return filepath.Join(directory, "devcontainer.json"), image, cleanup, nil
}

func requireNativeDependencyReference(ctx context.Context, assignment Assignment) error {
	if assignment.nativeDependencyReference == "" {
		return nil
	}
	identity, ok := strings.CutPrefix(assignment.nativeDependencyReference, "factory-native-dependencies:")
	if !ok || !regexpIdentity(identity) || assignment.nativeActorUID == "" || !prebuildImageID.MatchString(assignment.preparedRootFSImage) {
		return errors.New("native dependency local reference authority is unavailable")
	}
	output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{.Id}} {{index .Config.Labels \""+nativeDependencyLabel+"\"}}", assignment.nativeDependencyReference).Output()
	fields := strings.Fields(string(output))
	if err != nil || len(fields) != 2 || fields[0] != assignment.preparedRootFSImage || fields[1] != identity {
		return errors.New("native dependency local reference changed; no Dev Container was started")
	}
	return nil
}

func nativeDependencyImage(ctx context.Context, assignment Assignment, base string, trust []byte) (string, error) {
	if _, err := projectImageKey(base); err != nil {
		return "", err
	}
	// Preserve the base's declared user. FROM retains its remaining image metadata;
	// the networkless preparation runs only the bundled transport script as root.
	output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{json .Config.User}}", base).Output()
	var user string
	if err != nil || json.Unmarshal(output, &user) != nil || strings.ContainsAny(user, "\r\n\x00 ") {
		return "", errors.New("native dependency base user is unavailable")
	}
	if user == "" {
		user = "0"
	}
	dockerfile := "FROM " + base + "\nUSER 0:0\nCOPY trust.pem /tmp/factory-native-transport.pem\nCOPY transport.sh /tmp/factory-native-transport.sh\nRUN [\"/bin/sh\", \"/tmp/factory-native-transport.sh\", \"/\", \"/tmp/factory-native-transport.pem\"]\nRUN [\"/bin/rm\", \"/tmp/factory-native-transport.sh\", \"/tmp/factory-native-transport.pem\"]\nUSER " + user + "\n"
	input, _ := json.Marshal(struct {
		Attempt    string
		Actor      string
		Generation uint64
		Dockerfile string
		Trust      []byte
		Script     []byte
	}{assignment.RuntimeAttemptID, assignment.nativeActorUID, assignment.Generation, dockerfile, trust, nativeDependencyTransport})
	sum := sha256.Sum256(input)
	identity := hex.EncodeToString(sum[:])
	tag := "factory-native-dependencies:" + identity
	marker := filepath.Join(assignment.ConnectorStateDir, "native-dependencies-"+identity+".intended")
	_, markerErr := os.Lstat(marker)
	if markerErr != nil && !os.IsNotExist(markerErr) {
		return "", errors.New("native dependency intent ownership is unavailable")
	}
	inspect := func() (string, error) {
		output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{.Id}} {{index .Config.Labels \""+nativeDependencyLabel+"\"}}", tag).Output()
		fields := strings.Fields(string(output))
		if err != nil || len(fields) != 2 || !prebuildImageID.MatchString(fields[0]) || fields[1] != identity {
			return "", errors.New("native dependency image outcome is unconfirmed; original build is not repeated")
		}
		return fields[0], nil
	}
	if markerErr == nil {
		info, err := os.Lstat(marker)
		stored, readErr := os.ReadFile(marker)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || readErr != nil || string(stored) != identity {
			return "", errors.New("native dependency intent changed")
		}
		return inspect()
	}
	// Refuse a preexisting tag before recording this build's dispatch intent.
	prior, err := runtimeDockerCommand(ctx, "image", "ls", "--quiet", "--no-trunc", "--filter", "reference="+tag).Output()
	if err != nil || strings.TrimSpace(string(prior)) != "" {
		return "", errors.New("native dependency image already has an owner")
	}
	directory, err := os.MkdirTemp("/dev/shm", "factory-native-dependency-build-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(directory)
	for name, data := range map[string][]byte{"Dockerfile": []byte(dockerfile), "trust.pem": trust, "transport.sh": nativeDependencyTransport} {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			return "", err
		}
	}
	file, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", errors.New("native dependency build already has an intent")
	}
	_, writeErr := file.WriteString(identity)
	err = errors.Join(writeErr, file.Sync(), file.Close())
	if err != nil {
		return "", err
	}
	// No Project commands, grants, Parent token or network enter this build.
	_ = runtimeDockerCommand(ctx, "build", "--network=none", "--pull=false", "--label", nativeDependencyLabel+"="+identity, "--tag", tag, directory).Run()
	return inspect()
}

func nativeDependencyRemoteEnvironment(assignment Assignment, proxy string) []string {
	if assignment.nativeActorUID == "" {
		return nil
	}
	var args []string
	for _, value := range []string{
		"SSL_CERT_FILE=" + nativeDependencyCA, "GIT_SSL_CAINFO=" + nativeDependencyCA,
		"NODE_EXTRA_CA_CERTS=" + nativeDependencyCA, "CURL_CA_BUNDLE=" + nativeDependencyCA,
		"HTTP_PROXY=" + proxy, "HTTPS_PROXY=" + proxy,
		"http_proxy=" + proxy, "https_proxy=" + proxy,
		"NO_PROXY=localhost,127.0.0.1", "no_proxy=localhost,127.0.0.1",
	} {
		args = append(args, "--remote-env", value)
	}
	return args
}

func nativeDockerProxy(files environmentFiles) error {
	path := filepath.Join(files.dockerConfig, "config.json")
	content, err := os.ReadFile(path)
	var config map[string]json.RawMessage
	if err != nil || json.Unmarshal(content, &config) != nil {
		return errors.New("native Docker transport configuration is unavailable")
	}
	config["proxies"], _ = json.Marshal(map[string]any{"default": map[string]string{
		"httpProxy": "http://172.17.0.1:8888", "httpsProxy": "http://172.17.0.1:8888", "noProxy": "localhost,127.0.0.1",
	}})
	content, _ = json.Marshal(config)
	if err := os.WriteFile(path, content, 0600); err != nil {
		return fmt.Errorf("native Docker transport configuration: %w", err)
	}
	return nil
}
