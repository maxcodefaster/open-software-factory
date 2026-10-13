package connector

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type environmentVariable struct {
	Name         string `json:"name"`
	Value        string `json:"value"`
	Runtime      bool   `json:"runtime"`
	Build        bool   `json:"build"`
	Verification bool   `json:"verification"`
}
type environmentRegistry struct {
	Host         string `json:"host"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	Certificate  string `json:"certificate"`
	Verification bool   `json:"verification"`
}
type environmentBundle struct {
	Variables  []environmentVariable `json:"variables"`
	Registries []environmentRegistry `json:"registries"`
}
type runtimeEnvironment struct {
	Version uint64            `json:"version"`
	Bundle  environmentBundle `json:"bundle"`
}

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type dockerConfigContextKey struct{}
type registryCAContextKey struct{}

func runtimeDockerCommand(ctx context.Context, arguments ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, "docker", arguments...)
	if values, ok := ctx.Value(runtimeVariablesContextKey{}).(map[string]string); ok {
		command.Env = assignedEnvironment(os.Environ(), values)
	}
	if directory, ok := ctx.Value(dockerConfigContextKey{}).(string); ok {
		if command.Env == nil {
			command.Env = os.Environ()
		}
		command.Env = assignedEnvironment(command.Env, map[string]string{"DOCKER_CONFIG": directory})
	}
	return command
}

type runtimeVariablesContextKey struct{}

func devcontainerEnvironment(assignment Assignment) []string {
	values := make(map[string]string, len(assignment.RuntimeEnvironment)+2)
	for name, value := range assignment.RuntimeEnvironment {
		values[name] = value
	}
	if assignment.DockerConfigDirectory != "" {
		values["DOCKER_CONFIG"] = assignment.DockerConfigDirectory
		values["NODE_EXTRA_CA_CERTS"] = assignment.RegistryCAFile
	}
	return assignedEnvironment(os.Environ(), values)
}

func validateEnvironmentName(name string) bool {
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

// Child values arrive only on the parent's private stdin channel, never in
// the persisted assignment or Docker create metadata.
func ValidateRuntimeValues(values map[string]string) error {
	if len(values) > 128 {
		return errors.New("Invalid Connector child environment")
	}
	for name, value := range values {
		if !validateEnvironmentName(name) || len(value) > 65536 || strings.ContainsRune(value, 0) {
			return errors.New("Invalid Connector child environment")
		}
	}
	return nil
}
func (environment runtimeEnvironment) validate(version uint64) error {
	invalid := errors.New("Runtime environment configuration is invalid")
	if environment.Version != version || len(environment.Bundle.Variables) > 128 || len(environment.Bundle.Registries) > 16 {
		return invalid
	}
	names := map[string]bool{}
	for _, variable := range environment.Bundle.Variables {
		if !validateEnvironmentName(variable.Name) || names[variable.Name] || len(variable.Value) > 65536 || strings.ContainsRune(variable.Value, 0) {
			return invalid
		}
		names[variable.Name] = true
	}
	hosts := map[string]bool{}
	for _, registry := range environment.Bundle.Registries {
		parsed, err := url.Parse("https://" + registry.Host)
		if err != nil || parsed.Host != registry.Host || parsed.Host == "" || len(registry.Host) > 253 || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || hosts[registry.Host] || len(registry.Username) > 256 || strings.ContainsAny(registry.Username, ":\x00\r\n") || len(registry.Password) > 65536 || strings.ContainsRune(registry.Password, 0) {
			return invalid
		}
		hosts[registry.Host] = true
		if registry.Certificate != "" {
			if len(registry.Certificate) > 131072 {
				return invalid
			}
			rest := []byte(registry.Certificate)
			for len(strings.TrimSpace(string(rest))) > 0 {
				block, next := pem.Decode(rest)
				if block == nil || block.Type != "CERTIFICATE" {
					return invalid
				}
				if _, err := x509.ParseCertificate(block.Bytes); err != nil {
					return invalid
				}
				rest = next
			}
		}
	}
	return nil
}
func readRuntimeEnvironment(ctx context.Context, assignment Assignment, token string) (runtimeEnvironment, error) {
	if assignment.EnvironmentVersion == nil {
		return runtimeEnvironment{}, nil
	}
	endpoint, err := url.Parse(assignment.ControlURL)
	if err != nil {
		return runtimeEnvironment{}, errors.New("Invalid Factory endpoint")
	}
	if endpoint.Scheme == "wss" {
		endpoint.Scheme = "https"
	} else {
		endpoint.Scheme = "http"
	}
	endpoint.Path = "/internal/runtime-environment/" + assignment.RuntimeAttemptID
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return runtimeEnvironment{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Factory-Runtime-Generation", fmt.Sprint(assignment.Generation))
	client := http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return runtimeEnvironment{}, errors.New("Runtime environment is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return runtimeEnvironment{}, errors.New("Runtime environment access was denied or is unavailable")
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if err != nil || len(content) > 2*1024*1024 {
		return runtimeEnvironment{}, errors.New("Runtime environment response is invalid")
	}
	var environment runtimeEnvironment
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&environment) != nil {
		return environment, errors.New("Runtime environment response is invalid")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return environment, errors.New("Runtime environment response is invalid")
	}
	return environment, environment.validate(*assignment.EnvironmentVersion)
}

type environmentFiles struct {
	directory      string
	secretsFile    string
	dockerConfig   string
	caFile         string
	buildDirectory string
	lock           *os.File
}

func prepareEnvironmentFiles(environment runtimeEnvironment) (environmentFiles, error) {
	if err := requireMemoryFilesystem("/dev/shm"); err != nil {
		return environmentFiles{}, err
	}
	return prepareEnvironmentFilesAt(environment, "/dev/shm", "/run/factory-build-secrets")
}

func (files environmentFiles) cleanup() {
	if target, err := os.Readlink(files.buildDirectory); err == nil && target == filepath.Join(files.directory, "build") {
		_ = os.Remove(files.buildDirectory)
	}
	_ = os.RemoveAll(files.directory)
	if files.lock != nil {
		_ = unix.Flock(int(files.lock.Fd()), unix.LOCK_UN)
		_ = files.lock.Close()
	}
}

func prepareEnvironmentFilesAt(environment runtimeEnvironment, memoryDirectory, buildDirectory string) (environmentFiles, error) {
	if err := environment.validate(environment.Version); err != nil {
		return environmentFiles{}, err
	}
	fd, err := unix.Open(buildDirectory+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return environmentFiles{}, errors.New("Build secret storage is unavailable")
	}
	lock := os.NewFile(uintptr(fd), "environment-lock")
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return environmentFiles{}, errors.New("Build secret storage is already in use")
	}
	// Recover only our exact memory-backed directory while holding the private
	// runtime lock. A crash never leaves values on the retained Docker/workspace disk.
	if target, err := os.Readlink(buildDirectory); err == nil {
		root := filepath.Dir(target)
		info, statErr := os.Lstat(root)
		if filepath.Dir(root) != memoryDirectory || !strings.HasPrefix(filepath.Base(root), "factory-environment-") || filepath.Base(target) != "build" || statErr != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
			lock.Close()
			return environmentFiles{}, errors.New("Interrupted build secret ownership is unconfirmed")
		}
		if err := os.Remove(buildDirectory); err != nil {
			lock.Close()
			return environmentFiles{}, err
		}
		if err := os.RemoveAll(root); err != nil {
			lock.Close()
			return environmentFiles{}, err
		}
	} else if !os.IsNotExist(err) {
		lock.Close()
		return environmentFiles{}, errors.New("Build secret directory is already owned or unavailable")
	}
	directory, err := os.MkdirTemp(memoryDirectory, "factory-environment-")
	if err != nil {
		lock.Close()
		return environmentFiles{}, err
	}
	files := environmentFiles{directory: directory, secretsFile: filepath.Join(directory, "runtime.json"), dockerConfig: filepath.Join(directory, "docker"), caFile: filepath.Join(directory, "registry-ca.pem"), buildDirectory: buildDirectory, lock: lock}
	complete := false
	defer func() {
		if !complete {
			files.cleanup()
		}
	}()
	runtimeValues := map[string]string{}
	if err := os.Mkdir(filepath.Join(directory, "build"), 0700); err != nil {
		return files, errors.New("Build secret directory is already owned or unavailable")
	}
	if err := os.Symlink(filepath.Join(directory, "build"), files.buildDirectory); err != nil {
		return files, err
	}
	for _, variable := range environment.Bundle.Variables {
		if variable.Runtime {
			runtimeValues[variable.Name] = variable.Value
		}
		if variable.Build {
			if err := os.WriteFile(filepath.Join(files.buildDirectory, variable.Name), []byte(variable.Value), 0600); err != nil {
				return files, err
			}
		}
	}
	encoded, _ := json.Marshal(runtimeValues)
	if err := os.WriteFile(files.secretsFile, encoded, 0600); err != nil {
		return files, err
	}
	if err := os.Mkdir(files.dockerConfig, 0700); err != nil {
		return files, err
	}
	auths := map[string]map[string]string{}
	var certificates strings.Builder
	for _, registry := range environment.Bundle.Registries {
		auths[registry.Host] = map[string]string{"auth": base64.StdEncoding.EncodeToString([]byte(registry.Username + ":" + registry.Password))}
		certificates.WriteString(registry.Certificate)
		certificates.WriteByte('\n')
	}
	if err := os.WriteFile(files.caFile, []byte(certificates.String()), 0600); err != nil {
		return files, err
	}
	encoded, _ = json.Marshal(map[string]any{"auths": auths})
	if err := os.WriteFile(filepath.Join(files.dockerConfig, "config.json"), encoded, 0600); err != nil {
		return files, err
	}
	complete = true
	return files, nil
}
func assignedEnvironment(base []string, values map[string]string) []string {
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
