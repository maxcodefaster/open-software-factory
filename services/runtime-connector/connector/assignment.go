package connector

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/repositoryurl"
)

const AssignmentVersion = 1

var (
	identityPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	channelPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	composePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
)

type Assignment struct {
	Version                int                 `json:"version"`
	RuntimeAttemptID       string              `json:"runtimeAttemptId"`
	Generation             uint64              `json:"generation"`
	WorkspaceFolder        string              `json:"workspaceFolder"`
	RemoteWorkspaceFolder  string              `json:"remoteWorkspaceFolder"`
	RepositoryURL          string              `json:"repositoryUrl"`
	RepositoryIdentity     string              `json:"repositoryIdentity"`
	PreserveWorkspace      bool                `json:"preserveWorkspace"`
	Revision               string              `json:"revision"`
	DevcontainerPath       string              `json:"devcontainerPath"`
	ComposeProjectName     string              `json:"composeProjectName"`
	ControlURL             string              `json:"controlUrl"`
	Channels               []Channel           `json:"channels"`
	Processes              []Process           `json:"processes"`
	ConnectorStateDir      string              `json:"connectorStateDir,omitempty"`
	BrowserToolsImage      string              `json:"browserToolsImage,omitempty"`
	EnvironmentVersion     *uint64             `json:"environmentVersion,omitempty"`
	RuntimeEnvironment     map[string]string   `json:"-"`
	EnvironmentSecretsFile string              `json:"-"`
	DockerConfigDirectory  string              `json:"-"`
	RegistryCAFile         string              `json:"-"`
	Prebuild               *PrebuildAssignment `json:"prebuild,omitempty"`
	EffectiveConfiguration string              `json:"-"`
	PrebuildCacheImage     string              `json:"-"`
	containerOrigin        *containerOrigin
}

type containerOrigin struct {
	AttemptID          string `json:"attemptID"`
	Generation         uint64 `json:"generation"`
	ComposeProjectName string `json:"composeProjectName"`
}

func (assignment Assignment) containerIdentity() containerOrigin {
	if assignment.containerOrigin != nil {
		return *assignment.containerOrigin
	}
	return containerOrigin{assignment.RuntimeAttemptID, assignment.Generation, assignment.ComposeProjectName}
}

type PrebuildAssignment struct {
	ID              string `json:"id"`
	Platform        string `json:"platform"`
	ImageRepository string `json:"imageRepository"`
}

type Channel struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Target     string `json:"target"`
	HealthPath string `json:"healthPath"`
}

type Process struct {
	Name    string            `json:"name"`
	Label   string            `json:"label,omitempty"`
	Command []string          `json:"command"`
	Env     map[string]string `json:"env,omitempty"`
}

func ReadAssignment(path string) (Assignment, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Assignment{}, fmt.Errorf("read assignment: %w", err)
	}
	var assignment Assignment
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&assignment); err != nil {
		return Assignment{}, fmt.Errorf("decode assignment: %w", err)
	}
	if err := assignment.Validate(); err != nil {
		return Assignment{}, err
	}
	return assignment, nil
}

func (assignment Assignment) Validate() error {
	if assignment.Prebuild != nil && (assignment.Prebuild.ID == "" || (assignment.Prebuild.Platform != "native" && assignment.Prebuild.Platform != "linux/arm64" && assignment.Prebuild.Platform != "linux/amd64") || !strings.HasSuffix(assignment.Prebuild.ImageRepository, "/"+assignment.RepositoryIdentity)) {
		return errors.New("Invalid Project prebuild assignment")
	}
	if assignment.BrowserToolsImage != "" && !browserImagePattern.MatchString(assignment.BrowserToolsImage) {
		return errors.New("browser tools image must be pinned by exact digest")
	}
	if assignment.Version != AssignmentVersion {
		return fmt.Errorf("assignment version must be %d", AssignmentVersion)
	}
	if assignment.RuntimeAttemptID == "" || len(assignment.RuntimeAttemptID) > 64 {
		return errors.New("runtime attempt identity is invalid")
	}
	if assignment.Generation == 0 {
		return errors.New("generation must be positive")
	}
	if !filepath.IsAbs(assignment.WorkspaceFolder) || filepath.Clean(assignment.WorkspaceFolder) != assignment.WorkspaceFolder {
		return errors.New("workspace folder must be a clean absolute path")
	}
	if !filepath.IsAbs(assignment.RemoteWorkspaceFolder) || filepath.Clean(assignment.RemoteWorkspaceFolder) != assignment.RemoteWorkspaceFolder {
		return errors.New("remote workspace folder must be a clean absolute path")
	}
	if !repositoryurl.Valid(assignment.RepositoryURL) {
		return errors.New("repository URL must use HTTPS, file, or the local Factory bridge without credentials")
	}
	if !identityPattern.MatchString(assignment.RepositoryIdentity) {
		return errors.New("repository identity is invalid")
	}
	if assignment.Revision == "" || strings.HasPrefix(assignment.Revision, "-") || strings.Contains(assignment.Revision, "..") {
		return errors.New("repository revision is invalid")
	}
	if filepath.IsAbs(assignment.DevcontainerPath) || filepath.Clean(assignment.DevcontainerPath) != assignment.DevcontainerPath || strings.HasPrefix(assignment.DevcontainerPath, "..") {
		return errors.New("Dev Container path must stay within the workspace")
	}
	if !composePattern.MatchString(assignment.ComposeProjectName) {
		return errors.New("Compose project identity is invalid")
	}
	control, err := url.Parse(assignment.ControlURL)
	if err != nil || (control.Scheme != "ws" && control.Scheme != "wss") || control.Host == "" || control.User != nil {
		return errors.New("control URL must be an absolute ws or wss URL without user information")
	}
	if len(assignment.Channels) == 0 || len(assignment.Channels) > 8 {
		return errors.New("assignment must declare between one and eight channels")
	}
	seenChannels := make(map[string]struct{}, len(assignment.Channels))
	for _, channel := range assignment.Channels {
		if !channelPattern.MatchString(channel.Name) {
			return fmt.Errorf("channel %q has an invalid name", channel.Name)
		}
		if _, exists := seenChannels[channel.Name]; exists {
			return fmt.Errorf("channel %q is duplicated", channel.Name)
		}
		seenChannels[channel.Name] = struct{}{}
		if channel.Kind != "app" && channel.Kind != "ide" && channel.Kind != "agent" && channel.Kind != "verification" {
			return fmt.Errorf("channel %q has an invalid kind", channel.Name)
		}
		// The interactive capability scopes Connector PTY/process operations.
		// The developer's editor is independent and has no runtime HTTP target.
		if channel.Kind == "ide" {
			if channel.Target != "" || channel.HealthPath != "" {
				return errors.New("interactive capability cannot declare an editor target")
			}
			continue
		}
		if err := validateTarget(channel.Target); err != nil {
			return fmt.Errorf("channel %q: %w", channel.Name, err)
		}
		if channel.HealthPath == "" || !strings.HasPrefix(channel.HealthPath, "/") || strings.HasPrefix(channel.HealthPath, "//") {
			return fmt.Errorf("channel %q has an invalid health path", channel.Name)
		}
	}
	if len(assignment.Processes) > 8 {
		return errors.New("assignment declares too many processes")
	}
	seenProcesses := make(map[string]struct{}, len(assignment.Processes))
	for _, process := range assignment.Processes {
		if !channelPattern.MatchString(process.Name) {
			return fmt.Errorf("process %q has an invalid name", process.Name)
		}
		if _, exists := seenProcesses[process.Name]; exists {
			return fmt.Errorf("process %q is duplicated", process.Name)
		}
		seenProcesses[process.Name] = struct{}{}
		if len(process.Label) > 64 || strings.TrimSpace(process.Label) != process.Label {
			return fmt.Errorf("process %q has an invalid label", process.Name)
		}
		if len(process.Command) == 0 || len(process.Command) > 32 {
			return fmt.Errorf("process %q has an invalid command", process.Name)
		}
		for _, argument := range process.Command {
			if argument == "" || strings.ContainsRune(argument, 0) {
				return fmt.Errorf("process %q has an invalid command argument", process.Name)
			}
		}
		for name, value := range process.Env {
			if !channelPattern.MatchString(strings.ToLower(strings.ReplaceAll(name, "_", "-"))) || strings.ContainsRune(value, 0) {
				return fmt.Errorf("process %q has an invalid environment entry", process.Name)
			}
		}
	}
	return nil
}

func validateTarget(value string) error {
	target, err := url.Parse(value)
	if err != nil || target.Scheme != "http" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		return errors.New("target must be an absolute local HTTP URL")
	}
	host := target.Hostname()
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("target host must be loopback")
		}
	}
	if target.Port() == "" {
		return errors.New("target must include a port")
	}
	if target.Path != "" && target.Path != "/" {
		return errors.New("target must not include a path")
	}
	return nil
}

func (assignment Assignment) channel(name string) (Channel, bool) {
	for _, channel := range assignment.Channels {
		if channel.Name == name {
			return channel, true
		}
	}
	return Channel{}, false
}
