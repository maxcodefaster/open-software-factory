package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func runtimePrebuildRequest(ctx context.Context, assignment Assignment, token, method string, body []byte) ([]byte, error) {
	endpoint, err := url.Parse(assignment.ControlURL)
	if err != nil {
		return nil, errors.New("Invalid Factory endpoint")
	}
	if endpoint.Scheme == "wss" {
		endpoint.Scheme = "https"
	} else {
		endpoint.Scheme = "http"
	}
	endpoint.Path = "/internal/project-image/" + assignment.RuntimeAttemptID
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("Project image preparation request failed")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Factory-Runtime-Generation", fmt.Sprint(assignment.Generation))
	request.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Project image preparation service is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 && response.StatusCode != 204 {
		return nil, errors.New("Project image preparation service is unavailable")
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(content) > 4096 {
		return nil, errors.New("Project image preparation response is invalid")
	}
	return content, nil
}

func compatibleRuntimePrebuild(parent context.Context, assignment Assignment, token string) string {
	if assignment.EnvironmentVersion == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	content, err := runtimePrebuildRequest(ctx, assignment, token, "GET", nil)
	var result PrebuildResult
	if err != nil || json.Unmarshal(content, &result) != nil || !regexpIdentity(result.Identity) {
		return ""
	}
	key, err := projectImageKey(result.Image)
	if err != nil {
		return ""
	}
	status, err := prebuildGit(ctx, assignment.WorkspaceFolder, "status", "--porcelain")
	if err != nil || status != "" {
		return ""
	}
	platform, err := runtimePrebuildPlatform(ctx)
	if err != nil {
		return ""
	}
	input, snapshot, err := preparePrebuildInputWith(ctx, assignment, PrebuildRequest{Commit: assignment.Revision, Platform: platform, ImageRepository: strings.Split(key, "@")[0]}, readPrebuildConfiguration)
	if err != nil {
		return ""
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	if prebuildIdentity(input) != result.Identity {
		return ""
	}
	if acquireProjectImage(ctx, key) != nil {
		return ""
	}
	operation := prebuildOperation{Identity: result.Identity, Input: input, Directory: filepath.Dir(snapshot)}
	if _, err := inspectPrebuild(ctx, operation, key); err != nil {
		return ""
	}
	return key
}

func runtimePrebuildPlatform(ctx context.Context) (string, error) {
	output, err := runtimeDockerCommand(ctx, "info", "--format", "{{.OSType}}/{{.Architecture}}").Output()
	if err != nil {
		return "", errors.New("Project native build platform is unavailable")
	}
	switch strings.TrimSpace(string(output)) {
	case "linux/aarch64", "linux/arm64":
		return "linux/arm64", nil
	case "linux/x86_64", "linux/amd64":
		return "linux/amd64", nil
	default:
		return "", errors.New("Project native build platform is unsupported")
	}
}

func regexpIdentity(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !strings.ContainsRune("abcdef0123456789", c) {
			return false
		}
	}
	return true
}

func preparePrebuildConsumer(ctx context.Context, assignment Assignment, image string) (string, func(), error) {
	source, err := readPrebuildConfigurationDocument(ctx, assignment.WorkspaceFolder, filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	var config map[string]json.RawMessage
	if err != nil || json.Unmarshal(source, &config) != nil {
		return "", func() {}, errors.New("Prepared image recipe is unavailable")
	}
	if config["dockerComposeFile"] != nil {
		return "", func() {}, errors.New("Compose uses normal image preparation")
	}
	delete(config, "build")
	delete(config, "dockerFile")
	delete(config, "features")
	config["image"], _ = json.Marshal(image)
	directory, err := os.MkdirTemp("/dev/shm", "factory-prebuild-consumer-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	path := filepath.Join(directory, "devcontainer.json")
	encoded, _ := json.Marshal(config)
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return path, cleanup, nil
}

func publishRuntimePrebuild(ctx context.Context, assignment Assignment, token string, result PrebuildResult) error {
	encoded, _ := json.Marshal(result)
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := runtimePrebuildRequest(ctx, assignment, token, "POST", encoded); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return errors.New("Project image preparation acknowledgement is unavailable")
}
