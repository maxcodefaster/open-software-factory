package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var nativeProjectActorUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Factory supplies this entrypoint configuration; it is not Project JSON and
// never contains a Parent/native provisioner capability or registry credentials.
type nativeProject struct {
	Container   string     `json:"container"`
	EntryToken  string     `json:"entryToken"`
	FactoryCA   string     `json:"factoryCA"`
	Assignment  Assignment `json:"assignment"`
	ChildToken  string     `json:"childToken,omitempty"`
	Preparation *struct {
		Command []string `json:"command"`
	} `json:"preparation,omitempty"`
	Command []string `json:"command,omitempty"`
}

func decodeNativeProject(text string) (nativeProject, error) {
	var entry nativeProject
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.DisallowUnknownFields()
	if len(text) > 1<<20 || decoder.Decode(&entry) != nil || decoder.Decode(new(any)) != io.EOF {
		return entry, errors.New("native Project entry is invalid")
	}
	assignment := entry.Assignment
	endpoint, err := url.Parse(assignment.ControlURL)
	if !identityPattern.MatchString(entry.Container) || entry.EntryToken == "" ||
		strings.ContainsAny(entry.EntryToken, "\x00\r\n ") || assignment.Version != AssignmentVersion ||
		!identityPattern.MatchString(assignment.RuntimeAttemptID) || assignment.Generation == 0 ||
		assignment.EnvironmentVersion == nil || err != nil || endpoint.Scheme != "wss" ||
		endpoint.Host == "" || endpoint.User != nil || endpoint.Path != "/internal/runtime-connect" ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return entry, errors.New("native Project entry identity is invalid")
	}
	if entry.Container == "work" {
		if assignment.Validate() != nil || entry.ChildToken == "" || len(entry.Command) != 0 {
			return entry, errors.New("native Work assignment is invalid")
		}
		if entry.Preparation != nil && !nativeProjectCommand(entry.Preparation.Command) {
			return entry, errors.New("native Work preparation command is invalid")
		}
	} else if entry.ChildToken != "" || entry.Preparation != nil ||
		assignment.RepositoryURL != "" || assignment.RepositoryIdentity != "" ||
		assignment.WorkspaceFolder != "" || assignment.RemoteWorkspaceFolder != "" ||
		assignment.ConnectorStateDir != "" || len(assignment.Channels) != 0 ||
		len(assignment.Processes) != 0 || !nativeProjectCommand(entry.Command) {
		return entry, errors.New("native service received unsupported execution authority")
	}
	return entry, nil
}

func nativeProjectCommand(argv []string) bool {
	if len(argv) == 0 || len(argv) > 128 {
		return false
	}
	for _, argument := range argv {
		if argument == "" || len(argument) > 4096 || strings.ContainsRune(argument, 0) {
			return false
		}
	}
	return true
}

func nativeProjectVariable(name string) bool {
	if !validateEnvironmentName(name) || strings.HasPrefix(name, "ATE_") {
		return false
	}
	switch strings.ToUpper(name) {
	case "SSL_CERT_FILE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY":
		return false
	}
	return true
}

// Waiting for Source is a fixed authenticated GET, not a lifecycle retry.
// Neither a pending lease nor a transport failure grants Project execution.
func readNativeProjectEnvironment(ctx context.Context, entry nativeProject, actorUID string, client *http.Client) (runtimeEnvironment, error) {
	endpoint, err := url.Parse(entry.Assignment.ControlURL)
	if err != nil || endpoint.Scheme != "wss" || !nativeProjectActorUID.MatchString(actorUID) ||
		entry.Assignment.EnvironmentVersion == nil {
		return runtimeEnvironment{}, errors.New("native Project admission identity is invalid")
	}
	endpoint.Scheme, endpoint.Path, endpoint.RawQuery, endpoint.Fragment = "https", "/internal/runtime-environment/"+entry.Assignment.RuntimeAttemptID, "", ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return runtimeEnvironment{}, err
	}
	request.Header.Set("Authorization", "Bearer "+entry.EntryToken)
	request.Header.Set("X-Factory-Runtime-Generation", fmt.Sprint(entry.Assignment.Generation))
	request.Header.Set("X-Factory-Runtime-Actor-UID", actorUID)
	request.Header.Set("X-Factory-Runtime-Container", entry.Container)
	delay := 100 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			return runtimeEnvironment{}, err
		}
		response, err := client.Do(request.Clone(ctx))
		if err == nil {
			if response.StatusCode == http.StatusOK {
				var environment runtimeEnvironment
				content, readErr := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
				response.Body.Close()
				if readErr != nil || len(content) > 2<<20 {
					return runtimeEnvironment{}, errors.New("native Project environment exceeds its bound")
				}
				decoder := json.NewDecoder(strings.NewReader(string(content)))
				decoder.DisallowUnknownFields()
				decodeErr := decoder.Decode(&environment)
				if decodeErr == nil && decoder.Decode(new(any)) != io.EOF {
					decodeErr = errors.New("native Project environment contains trailing data")
				}
				if decodeErr != nil || environment.Validate(*entry.Assignment.EnvironmentVersion) != nil {
					return runtimeEnvironment{}, errors.New("native Project environment is invalid")
				}
				for _, variable := range environment.Bundle.Variables {
					if !variable.Runtime || !nativeProjectVariable(variable.Name) {
						return runtimeEnvironment{}, errors.New("native Project received non-runtime authority")
					}
				}
				return environment, nil
			}
			response.Body.Close()
			if response.StatusCode != http.StatusConflict && response.StatusCode != http.StatusBadGateway &&
				response.StatusCode != http.StatusServiceUnavailable && response.StatusCode != http.StatusGatewayTimeout {
				return runtimeEnvironment{}, errors.New("native Project execution was not authorized")
			}
		} else if !retryRuntimeEnvironmentRead(err) {
			return runtimeEnvironment{}, errors.New("native Project serving identity is unavailable")
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return runtimeEnvironment{}, ctx.Err()
		case <-timer.C:
		}
		delay = min(2*delay, time.Second)
	}
}
