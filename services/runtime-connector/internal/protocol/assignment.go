package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/repositoryurl"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

const AssignmentVersion = 1

var (
	IdentityPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	ChannelPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	BrowserImagePattern = regexp.MustCompile(`^(?:[a-zA-Z0-9.:/-]+@)?sha256:[a-f0-9]{64}$`)
	UUIDPattern         = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type Assignment struct {
	Version               int    `json:"version"`
	RuntimeAttemptID      string `json:"runtimeAttemptId"`
	Generation            uint64 `json:"generation"`
	WorkspaceFolder       string `json:"workspaceFolder"`
	RemoteWorkspaceFolder string `json:"remoteWorkspaceFolder"`
	// Observed native Work checkout root, which may contain the selected
	// Workspace folder.
	CheckoutFolder     string            `json:"checkoutFolder,omitempty"`
	RepositoryURL      string            `json:"repositoryUrl"`
	RepositoryIdentity string            `json:"repositoryIdentity"`
	PreserveWorkspace  bool              `json:"preserveWorkspace"`
	Revision           string            `json:"revision"`
	ActorTemplatePath  string            `json:"actorTemplatePath"`
	ControlURL         string            `json:"controlUrl"`
	Channels           []Channel         `json:"channels"`
	Processes          []Process         `json:"processes"`
	ConnectorStateDir  string            `json:"connectorStateDir,omitempty"`
	BrowserToolsImage  string            `json:"browserToolsImage,omitempty"`
	EnvironmentVersion *uint64           `json:"environmentVersion,omitempty"`
	RuntimeEnvironment map[string]string `json:"-"`
	// Set only by the verified native bootstrap, never decoded from Project JSON.
	nativeActorUID string
	// Installed only by native-parent after checkout and Actor identity validation.
	// Never serialized into the Child or accepted from a Project assignment.
	nativeSource  http.Handler
	nativeWriters *writergate.Gate
}

func (assignment Assignment) NativeActorUID() string {
	return assignment.nativeActorUID
}

func (assignment *Assignment) SetNativeActorUID(uid string) {
	assignment.nativeActorUID = uid
}

func (assignment Assignment) NativeSource() http.Handler {
	return assignment.nativeSource
}

func (assignment *Assignment) SetNativeSource(handler http.Handler) {
	assignment.nativeSource = handler
}

func (assignment Assignment) NativeWriters() *writergate.Gate {
	return assignment.nativeWriters
}

func (assignment *Assignment) SetNativeWriters(gate *writergate.Gate) {
	assignment.nativeWriters = gate
}

func (assignment Assignment) StartNativeWriter(start func() error) error {
	return assignment.nativeWriters.Start(start)
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
	if assignment.BrowserToolsImage != "" && !BrowserImagePattern.MatchString(assignment.BrowserToolsImage) {
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
	if assignment.CheckoutFolder != "" {
		relative, err := filepath.Rel(assignment.CheckoutFolder, assignment.WorkspaceFolder)
		if !filepath.IsAbs(assignment.CheckoutFolder) || filepath.Clean(assignment.CheckoutFolder) != assignment.CheckoutFolder ||
			err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errors.New("checkout folder must be a clean absolute ancestor of the workspace folder")
		}
	}
	if !repositoryurl.Valid(assignment.RepositoryURL) {
		return errors.New("repository URL must use HTTPS, file, or the local Factory bridge without credentials")
	}
	if !IdentityPattern.MatchString(assignment.RepositoryIdentity) {
		return errors.New("repository identity is invalid")
	}
	if assignment.Revision == "" || strings.HasPrefix(assignment.Revision, "-") || strings.Contains(assignment.Revision, "..") {
		return errors.New("repository revision is invalid")
	}
	if filepath.IsAbs(assignment.ActorTemplatePath) || filepath.Clean(assignment.ActorTemplatePath) != assignment.ActorTemplatePath || strings.HasPrefix(assignment.ActorTemplatePath, "..") {
		return errors.New("Project ActorTemplate path must stay within the workspace")
	}
	control, err := url.Parse(assignment.ControlURL)
	if err != nil || (control.Scheme != "ws" && control.Scheme != "wss") || control.Host == "" || control.User != nil {
		return errors.New("control URL must be an absolute ws or wss URL without user information")
	}
	// The Bearer capability crosses this connection. Plain ws is limited to the
	// local or private installation endpoints.
	if control.Scheme == "ws" && !repositoryurl.PrivateHost(control.Hostname()) {
		return errors.New("control URL must use wss unless it targets a loopback or private installation endpoint")
	}
	if len(assignment.Channels) == 0 || len(assignment.Channels) > 8 {
		return errors.New("assignment must declare between one and eight channels")
	}
	seenChannels := make(map[string]struct{}, len(assignment.Channels))
	for _, channel := range assignment.Channels {
		if !ChannelPattern.MatchString(channel.Name) {
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
		if err := ValidateTarget(channel.Target); err != nil {
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
		if !ChannelPattern.MatchString(process.Name) {
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
			if !ChannelPattern.MatchString(strings.ToLower(strings.ReplaceAll(name, "_", "-"))) || strings.ContainsRune(value, 0) {
				return fmt.Errorf("process %q has an invalid environment entry", process.Name)
			}
		}
	}
	return nil
}

func ValidateTarget(value string) error {
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

func (assignment Assignment) Channel(name string) (Channel, bool) {
	for _, channel := range assignment.Channels {
		if channel.Name == name {
			return channel, true
		}
	}
	return Channel{}, false
}
