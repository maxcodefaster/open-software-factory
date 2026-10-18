package connector

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var browserImagePattern = regexp.MustCompile(`^(?:[a-zA-Z0-9.:/-]+@)?sha256:[a-f0-9]{64}$`)
var browserOwnerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var browserContainerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var errBrowserPagePending = errors.New("declared App navigation has not committed a page yet")

type browserRuntimeRequest struct {
	SessionID      string          `json:"sessionId"`
	TurnID         string          `json:"turnId"`
	AgentSessionID string          `json:"agentSessionId"`
	OwnerID        string          `json:"ownerId"`
	ExpiresAt      time.Time       `json:"expiresAt"`
	Call           browserToolCall `json:"call"`
}

type browserRuntime struct {
	scope      browserRuntimeRequest
	directory  string
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	authority  sync.Mutex
	expiresAt  time.Time
	input      io.WriteCloser
	responses  chan browserMCPReply
	command    *exec.Cmd
	wait       chan error
	sequence   int
	pageID     int
	app        string
	pendingApp string
	closed     bool
}

type browserRuntimeManager struct {
	assignment  Assignment
	primaryID   string
	primaryUser string
	ctx         context.Context
	preparation *browserImagePreparation
	mu          sync.Mutex
	sessions    map[string]*browserRuntime
	docker      func(context.Context, ...string) ([]byte, error)
}

func newBrowserRuntimeManager(ctx context.Context, assignment Assignment, primaryID, primaryUser string) *browserRuntimeManager {
	return &browserRuntimeManager{assignment: assignment, primaryID: primaryID, primaryUser: primaryUser, ctx: ctx, sessions: make(map[string]*browserRuntime), docker: browserDocker}
}

// RunParent owns the returned cancel function and invokes it before disconnect
// cleanup and on exit. Reconnection gets a fresh scope, never the old context.
func browserConnectionContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithCancel(parent)
}

func browserRuntimeNames(id string) (string, string) {
	digest := sha256.Sum256([]byte("factory-browser-v1:" + id))
	name := fmt.Sprintf("factory-browser-%x", digest[:12])
	return name, name + "-app"
}

func (manager *browserRuntimeManager) directory(id string) string {
	root := manager.assignment.ConnectorStateDir
	if root == "" {
		root = "/var/lib/factory/runtime-connector"
	}
	return filepath.Join(root, "browser-"+id)
}

func decodeBrowserRuntimeRequest(message Message, assignment Assignment) (browserRuntimeRequest, error) {
	invalid := errors.New("browser operation does not match its admitted execution scope")
	var request browserRuntimeRequest
	decoder := json.NewDecoder(strings.NewReader(message.Data))
	decoder.DisallowUnknownFields()
	if len(message.Data) > 16384 || decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF ||
		message.OperationID == "" || message.AttemptID != assignment.RuntimeAttemptID || message.Generation != assignment.Generation ||
		!identityPattern.MatchString(request.SessionID) || !identityPattern.MatchString(request.TurnID) ||
		!browserOwnerPattern.MatchString(request.OwnerID) || !strings.HasPrefix(request.AgentSessionID, "ses") ||
		len(request.AgentSessionID) > 200 {
		return request, invalid
	}
	if message.Action != "browser-close" && (time.Until(request.ExpiresAt) <= 0 || time.Until(request.ExpiresAt) > 30*time.Second) {
		return request, errors.New("browser execution lease is expired or exceeds its bound")
	}
	return request, nil
}

func sameBrowserScope(left, right browserRuntimeRequest) bool {
	return left.SessionID == right.SessionID && left.TurnID == right.TurnID &&
		left.OwnerID == right.OwnerID && left.AgentSessionID == right.AgentSessionID
}

func (manager *browserRuntimeManager) handle(ctx context.Context, message Message) Message {
	response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	request, err := decodeBrowserRuntimeRequest(message, manager.assignment)
	if err == nil && ctx.Err() != nil {
		err = errors.New("browser control connection ended")
	}
	if err == nil {
		switch message.Action {
		case "browser-close":
			err = manager.closeSession(request)
		case "browser-renew":
			err = manager.renew(request)
		case "browser-call":
			response.Data, err = manager.call(ctx, request)
		default:
			err = errors.New("unsupported browser operation")
		}
	}
	if err != nil {
		response.Error = err.Error()
	}
	return response
}

func browserDocker(ctx context.Context, arguments ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "docker", arguments...)
	var output browserDockerOutput
	command.Stdout = &output
	// Docker error output can contain registry or daemon details. Never expose it
	// through the MCP tool response or copy it into compact product Evidence.
	command.Stderr = io.Discard
	if command.Run() != nil {
		return nil, errors.New("browser container operation was not confirmed")
	}
	return output.Bytes(), nil
}

type browserDockerOutput struct{ buffer bytes.Buffer }

func (output *browserDockerOutput) Bytes() []byte { return output.buffer.Bytes() }
func (output *browserDockerOutput) Len() int      { return output.buffer.Len() }

func (output *browserDockerOutput) Write(data []byte) (int, error) {
	if output.Len()+len(data) > 128<<10 {
		return 0, errors.New("browser container observation exceeds its bound")
	}
	return output.buffer.Write(data)
}

func writeBrowserAuthority(directory string, request browserRuntimeRequest) error {
	content, err := json.Marshal(browserAuthority{SessionID: request.SessionID, ExpiresAt: request.ExpiresAt})
	if err != nil {
		return err
	}
	path := filepath.Join(directory, "config", "authority.json")
	file, err := os.CreateTemp(filepath.Dir(path), ".authority-")
	if err != nil {
		return errors.New("browser execution lease could not be written")
	}
	defer os.Remove(file.Name())
	_, written := file.Write(content)
	protected := file.Chmod(0444)
	closed := file.Close()
	if errors.Join(written, protected, closed) != nil {
		return errors.New("browser execution lease could not be written")
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return errors.New("browser execution lease could not be replaced")
	}
	return nil
}

func (runtime *browserRuntime) renewAuthority(scope browserRuntimeRequest, renewal bool) error {
	// Browser calls hold mu while starting containers and awaiting MCP. Renewal
	// must progress independently or a slow authorized call expires itself.
	runtime.authority.Lock()
	defer runtime.authority.Unlock()
	if !sameBrowserScope(runtime.scope, scope) || runtime.ctx.Err() != nil {
		return errors.New("browser renewal does not own this execution")
	}
	if !runtime.expiresAt.IsZero() && !time.Now().Before(runtime.expiresAt) {
		return errors.New("browser execution authority ended")
	}
	// An explicit renewal may shorten authority. A call admitted before a newer
	// renewal must not overwrite it with its stale startup deadline.
	if renewal || runtime.expiresAt.IsZero() {
		runtime.expiresAt = scope.ExpiresAt
	}
	scope.ExpiresAt = runtime.expiresAt
	if err := os.MkdirAll(filepath.Join(runtime.directory, "config"), 0755); err != nil {
		return errors.New("browser socket/configuration directory unavailable")
	}
	return writeBrowserAuthority(runtime.directory, scope)
}

func browserCreateArguments(assignment Assignment, primaryID, directory string, scope browserRuntimeRequest, proxy bool) ([]string, error) {
	if !browserImagePattern.MatchString(assignment.BrowserToolsImage) || !browserContainerPattern.MatchString(primaryID) ||
		!filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return nil, errors.New("pinned browser image or exact primary container is unavailable")
	}
	browserName, proxyName := browserRuntimeNames(scope.SessionID)
	name, network, mount := browserName, "none", ",readonly"
	if proxy {
		name, network, mount = proxyName, "container:"+primaryID, ""
	}
	arguments := []string{
		"create", "--name", name, "--label", "factory.dev/browser-session=" + scope.SessionID,
		"--label", attemptLabel + "=" + assignment.RuntimeAttemptID,
		"--label", generationLabel + "=" + strconv.FormatUint(assignment.Generation, 10),
		"--label", "factory.dev/browser-turn=" + scope.TurnID,
		"--label", "factory.dev/browser-owner=" + scope.OwnerID,
		"--label", "com.docker.compose.project=" + assignment.ComposeProjectName,
		"--network", network, "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "768m", "--cpus", "1",
		"--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
		"--mount", "type=bind,src=" + filepath.Join(directory, "socket") + ",dst=/factory/browser" + mount,
		"--mount", "type=bind,src=" + filepath.Join(directory, "config") + ",dst=/factory/browser/config,readonly",
	}
	if proxy {
		arguments = append(arguments, "--entrypoint", "/usr/local/bin/factory-browser-app-proxy")
	} else {
		arguments = append(arguments, "--interactive")
	}
	return append(arguments, assignment.BrowserToolsImage), nil
}

func (manager *browserRuntimeManager) inspectOwned(ctx context.Context, name string, scope browserRuntimeRequest) (inspectedContainer, error) {
	output, err := manager.docker(ctx, "inspect", name)
	if err != nil {
		return inspectedContainer{}, err
	}
	var containers []inspectedContainer
	if json.Unmarshal(output, &containers) != nil || len(containers) != 1 {
		return inspectedContainer{}, errors.New("browser container identity is unavailable")
	}
	container := containers[0]
	labels := container.Config.Labels
	if labels["factory.dev/browser-session"] != scope.SessionID || labels["factory.dev/browser-turn"] != scope.TurnID ||
		labels["factory.dev/browser-owner"] != scope.OwnerID || labels[attemptLabel] != manager.assignment.RuntimeAttemptID ||
		labels[generationLabel] != strconv.FormatUint(manager.assignment.Generation, 10) ||
		labels["com.docker.compose.project"] != manager.assignment.ComposeProjectName {
		return inspectedContainer{}, errors.New("refusing non-owned browser container")
	}
	return container, nil
}

func validateBrowserIsolation(container inspectedContainer, assignment Assignment, primaryID, directory string, proxy bool) error {
	denied := errors.New("browser container did not retain its exact isolation boundary")
	network := "none"
	if proxy {
		network = "container:" + primaryID
	}
	host := container.HostConfig
	if host.NetworkMode != network || !host.ReadonlyRootfs || host.Privileged ||
		container.Config.User != "1000:1000" || container.Config.Image != assignment.BrowserToolsImage ||
		host.PidMode != "" || host.IpcMode == "host" || host.UTSMode != "" || host.CgroupnsMode == "host" ||
		len(host.CapAdd) != 0 || len(host.CapDrop) != 1 || host.CapDrop[0] != "ALL" ||
		len(host.Devices) != 0 || len(host.VolumesFrom) != 0 || len(host.SecurityOpt) != 1 ||
		(host.SecurityOpt[0] != "no-new-privileges" && host.SecurityOpt[0] != "no-new-privileges=true") ||
		host.Memory != 768<<20 || host.NanoCpus != 1_000_000_000 || host.PidsLimit != 256 ||
		len(host.Tmpfs) != 1 || host.Tmpfs["/tmp"] != "rw,nosuid,nodev,size=256m,mode=1777" || len(container.Mounts) != 2 {
		return denied
	}
	seen := make(map[string]bool)
	for _, mount := range container.Mounts {
		child, writable := "", false
		switch mount.Destination {
		case "/factory/browser":
			child, writable = "socket", proxy
		case "/factory/browser/config":
			child = "config"
		default:
			return denied
		}
		if seen[child] || mount.Type != "bind" || mount.Source != filepath.Join(directory, child) || mount.RW != writable {
			return denied
		}
		seen[child] = true
	}
	return nil
}

func (manager *browserRuntimeManager) start(runtime *browserRuntime) error {
	ctx, end := context.WithTimeout(runtime.ctx, 25*time.Second)
	defer end()
	if _, err := manager.inspectPrimary(ctx); err != nil {
		return err
	}
	for _, child := range []string{"config", "socket/config"} {
		if err := os.MkdirAll(filepath.Join(runtime.directory, child), 0755); err != nil {
			return errors.New("browser socket/configuration directory unavailable")
		}
	}
	if err := os.Chown(filepath.Join(runtime.directory, "socket"), 1000, 1000); err != nil {
		return errors.New("browser socket directory ownership unavailable")
	}
	channels := make([]Channel, 0)
	for _, channel := range manager.assignment.Channels {
		if channel.Kind == "app" {
			channels = append(channels, channel)
		}
	}
	if _, err := browserWorkerArguments(channels); err != nil {
		return err
	}
	config, _ := json.Marshal(channels)
	if err := os.WriteFile(filepath.Join(runtime.directory, "config", "apps.json"), config, 0444); err != nil {
		return errors.New("browser App assignment could not be written")
	}
	if err := runtime.renewAuthority(runtime.scope, false); err != nil {
		return err
	}
	recordedScope, _ := json.Marshal(runtime.scope)
	if err := os.WriteFile(filepath.Join(runtime.directory, "scope.json"), recordedScope, 0400); err != nil {
		return errors.New("browser execution scope could not be recorded")
	}
	browserName, proxyName := browserRuntimeNames(runtime.scope.SessionID)
	for _, proxy := range []bool{true, false} {
		arguments, err := browserCreateArguments(manager.assignment, manager.primaryID, runtime.directory, runtime.scope, proxy)
		if err != nil {
			return err
		}
		_, created := manager.docker(ctx, arguments...)
		name := browserName
		if proxy {
			name = proxyName
		}
		container, observed := manager.inspectOwned(ctx, name, runtime.scope)
		if observed != nil {
			return errors.New("browser create outcome could not be recovered by its persisted identity")
		}
		if err := validateBrowserIsolation(container, manager.assignment, manager.primaryID, runtime.directory, proxy); err != nil {
			return err
		}
		// A previously running browser has unknown protocol/page state. Do not
		// attach, replay tools or silently replace it under the same create intent.
		if created != nil && container.State.Running {
			return errors.New("browser session outcome was lost; open a fresh browser session")
		}
		if proxy {
			if _, err := manager.docker(ctx, "start", proxyName); err != nil {
				return err
			}
		}
	}
	for attempt := 0; attempt < 50; attempt++ {
		if info, err := os.Stat(filepath.Join(runtime.directory, "socket", "app.sock")); err == nil && info.Mode()&os.ModeSocket != 0 {
			break
		}
		if ctx.Err() != nil {
			return errors.New("browser App proxy startup exceeded its authority")
		}
		if attempt == 49 {
			return errors.New("browser App proxy did not become ready within five seconds")
		}
		time.Sleep(100 * time.Millisecond)
	}
	command := exec.CommandContext(runtime.ctx, "docker", "start", "--attach", "--interactive", browserName)
	var err error
	runtime.input, err = command.StdinPipe()
	if err != nil {
		return errors.New("browser tool input unavailable")
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return errors.New("browser tool output unavailable")
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return errors.New("browser tool process failed to start")
	}
	runtime.command, runtime.wait = command, make(chan error, 1)
	go func() { runtime.wait <- command.Wait() }()
	runtime.responses = make(chan browserMCPReply, 4)
	go func() {
		defer close(runtime.responses)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 65536), 3<<20)
		for scanner.Scan() {
			var response browserMCPReply
			if json.Unmarshal(scanner.Bytes(), &response) == nil && response.ID != 0 {
				select {
				case runtime.responses <- response:
				case <-runtime.ctx.Done():
					return
				}
			}
		}
	}()
	initialized, err := runtime.rpc(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "factory-build-browser", "version": "1"},
	})
	if err != nil {
		return err
	}
	var identity struct {
		ServerInfo struct {
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	if json.Unmarshal(initialized, &identity) != nil || identity.ServerInfo.Version != "1.10.1" {
		return errors.New("browser MCP did not report the pinned upstream version")
	}
	if err := json.NewEncoder(runtime.input).Encode(map[string]string{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		return errors.New("browser MCP initialization was not confirmed")
	}
	return nil
}

func (runtime *browserRuntime) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	runtime.sequence++
	if err := json.NewEncoder(runtime.input).Encode(map[string]any{
		"jsonrpc": "2.0", "id": runtime.sequence, "method": method, "params": params,
	}); err != nil {
		return nil, errors.New("browser tool dispatch was not confirmed")
	}
	select {
	case response, ok := <-runtime.responses:
		if !ok || response.ID != runtime.sequence || len(response.Error) != 0 {
			return nil, errors.New("browser tool outcome is unavailable; do not repeat a UI mutation without checking the App")
		}
		return response.Result, nil
	case <-ctx.Done():
		return nil, errors.New("browser tool exceeded its execution authority or deadline")
	case <-runtime.ctx.Done():
		return nil, errors.New("browser execution authority ended")
	}
}

func (runtime *browserRuntime) selectDeclaredPage(raw json.RawMessage, app string) error {
	var page struct {
		IsError    bool `json:"isError"`
		Structured struct {
			Pages []struct {
				ID       int    `json:"id"`
				URL      string `json:"url"`
				Selected bool   `json:"selected"`
			} `json:"pages"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(raw, &page) != nil || page.IsError {
		return errors.New("browser App page identity unavailable")
	}
	selected, pageID, pending := 0, 0, false
	for _, current := range page.Structured.Pages {
		if !current.Selected {
			continue
		}
		selected++
		if current.ID <= 0 {
			return errors.New("browser did not retain the declared App page identity")
		}
		if current.URL == "about:blank" {
			pending = true
		} else if !strings.HasPrefix(current.URL, "http://"+app+".factory.invalid/") {
			return errors.New("browser did not retain the declared App page identity")
		}
		pageID = current.ID
	}
	if selected != 1 {
		return errors.New("browser did not retain the declared App page identity")
	}
	if pending {
		return errBrowserPagePending
	}
	runtime.pageID, runtime.app, runtime.pendingApp = pageID, app, ""
	return nil
}

func (manager *browserRuntimeManager) call(ctx context.Context, scope browserRuntimeRequest) (string, error) {
	if manager.preparation != nil {
		if err := manager.preparation.ready(); err != nil {
			return "", err
		}
	}
	manager.mu.Lock()
	if ctx.Err() != nil || manager.ctx.Err() != nil {
		manager.mu.Unlock()
		return "", errors.New("browser control connection ended")
	}
	runtime := manager.sessions[scope.SessionID]
	if runtime == nil {
		if scope.Call.Name != "browser_open" || !browserImagePattern.MatchString(manager.assignment.BrowserToolsImage) {
			manager.mu.Unlock()
			return "", errors.New("open a declared App with the configured pinned browser tools first")
		}
		if _, err := os.Stat(filepath.Join(manager.directory(scope.SessionID), "ended")); err == nil {
			manager.mu.Unlock()
			return "", errors.New("browser session already ended; open a fresh browser session")
		}
		if _, err := os.Stat(filepath.Join(manager.directory(scope.SessionID), "scope.json")); err == nil {
			manager.mu.Unlock()
			return "", errors.New("browser session requires owned cleanup after parent restart; do not replay a UI mutation")
		}
		if _, err := resolveBrowserTool(manager.assignment.Channels, 0, scope.Call); err != nil {
			manager.mu.Unlock()
			return "", err
		}
		live, cancel := context.WithCancel(ctx)
		runtime = &browserRuntime{scope: scope, directory: manager.directory(scope.SessionID), ctx: live, cancel: cancel}
		manager.sessions[scope.SessionID] = runtime
	}
	manager.mu.Unlock()
	if err := runtime.renewAuthority(scope, true); err != nil {
		return "", err
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !sameBrowserScope(runtime.scope, scope) || runtime.ctx.Err() != nil {
		return "", errors.New("browser session does not belong to the active execution owner")
	}
	recoveringNavigation := runtime.pendingApp != ""
	var dispatch browserToolDispatch
	if recoveringNavigation {
		if scope.Call.Name != "browser_snapshot" {
			return "", errors.New("inspect a fresh browser_snapshot before another browser action")
		}
	} else {
		var err error
		dispatch, err = resolveBrowserTool(manager.assignment.Channels, runtime.pageID, scope.Call)
		if err != nil {
			return "", err
		}
	}
	if runtime.command == nil {
		if err := manager.start(runtime); err != nil {
			runtime.cancel()
			go manager.closeSession(scope)
			return "", err
		}
		go func() {
			lease, cancel, err := browserAuthorityContext(runtime.ctx, filepath.Join(runtime.directory, "config", "authority.json"))
			if err == nil {
				<-lease.Done()
				cancel()
			}
			manager.closeSession(scope)
		}()
	}
	timeout := 15 * time.Second
	if scope.Call.Name == "browser_open" {
		// Upstream's ten-second navigation timeout starts after cold Chrome
		// launch. Keep both inside one bounded open without replaying navigation.
		timeout = 25 * time.Second
	}
	bounded, end := context.WithTimeout(runtime.ctx, timeout)
	defer end()
	if recoveringNavigation {
		// A known navigation error can leave a readable page. Establish its
		// selected declared origin through a fixed read, never another navigation
		// or an untrusted App-text claim. Share the ordinary snapshot deadline.
		for {
			pages, err := runtime.rpc(bounded, "tools/call", map[string]any{"name": "list_pages", "arguments": map[string]any{}})
			if err != nil {
				runtime.cancel()
				go manager.closeSession(scope)
				return "", err
			}
			err = runtime.selectDeclaredPage(pages, runtime.pendingApp)
			if err == nil {
				break
			}
			if !errors.Is(err, errBrowserPagePending) {
				return "", err
			}
			select {
			case <-bounded.Done():
				return "", errBrowserPagePending
			case <-time.After(100 * time.Millisecond):
			}
		}
		var err error
		dispatch, err = resolveBrowserTool(manager.assignment.Channels, runtime.pageID, scope.Call)
		if err != nil {
			return "", err
		}
	}
	raw, err := runtime.rpc(bounded, "tools/call", map[string]any{"name": dispatch.Name, "arguments": dispatch.Arguments})
	if err != nil {
		runtime.cancel()
		go manager.closeSession(scope)
		return "", err
	}
	result, err := boundBrowserResult(scope.Call.Name, raw)
	if err != nil {
		return "", err
	}
	if result.IsError {
		if scope.Call.Name == "browser_open" {
			runtime.pendingApp = dispatch.App
		}
		// A failed navigation has no selected App or successful observation. Keep
		// bounded error text, not a fabricated checkout context or screenshot.
		text := result.Content[:0]
		for _, item := range result.Content {
			if item.Type == "text" {
				text = append(text, item)
			}
		}
		result.Content = text
		encoded, err := json.Marshal(result)
		return string(encoded), err
	}
	if scope.Call.Name == "browser_open" && !result.IsError {
		if err := runtime.selectDeclaredPage(raw, dispatch.App); err != nil {
			return "", err
		}
	}
	result.StructuredContent, err = manager.observationContext(bounded, scope, runtime.app)
	if err != nil {
		return "", err
	}
	if scope.Call.Name == "browser_screenshot" && !result.IsError {
		if err := manager.writeScreenshot(bounded, runtime, result); err != nil {
			return "", err
		}
	}
	encoded, err := json.Marshal(result)
	return string(encoded), err
}

func (manager *browserRuntimeManager) renew(scope browserRuntimeRequest) error {
	manager.mu.Lock()
	runtime := manager.sessions[scope.SessionID]
	manager.mu.Unlock()
	if runtime == nil {
		// An intended session can be renewed before its first call, including
		// while the exact image is preparing. Do not create execution or a lease.
		if _, err := os.Stat(filepath.Join(manager.directory(scope.SessionID), "ended")); err == nil {
			return errors.New("browser session is no longer active")
		}
		return nil
	}
	return runtime.renewAuthority(scope, true)
}

func (manager *browserRuntimeManager) closeSession(scope browserRuntimeRequest) error {
	manager.mu.Lock()
	runtime := manager.sessions[scope.SessionID]
	if runtime != nil && !sameBrowserScope(runtime.scope, scope) {
		manager.mu.Unlock()
		return errors.New("browser cleanup does not own this execution")
	}
	if runtime != nil {
		runtime.cancel()
	}
	manager.mu.Unlock()
	if runtime != nil {
		runtime.mu.Lock()
		defer runtime.mu.Unlock()
		if runtime.closed {
			return nil
		}
	}
	directory := manager.directory(scope.SessionID)
	if content, err := os.ReadFile(filepath.Join(directory, "scope.json")); err == nil {
		var recorded browserRuntimeRequest
		if json.Unmarshal(content, &recorded) != nil || !sameBrowserScope(recorded, scope) {
			return errors.New("browser cleanup does not own the recorded execution")
		}
	}
	if err := os.MkdirAll(filepath.Join(directory, "config"), 0755); err != nil {
		return errors.New("browser end directory unavailable")
	}
	{
		if runtime != nil {
			runtime.authority.Lock()
			defer runtime.authority.Unlock()
		}
		expired := scope
		expired.ExpiresAt = time.Now().Add(-time.Second)
		if err := writeBrowserAuthority(directory, expired); err != nil {
			return err
		}
		marker, err := os.OpenFile(filepath.Join(directory, "ended"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0444)
		if err != nil && !errors.Is(err, os.ErrExist) {
			return errors.New("browser end outcome could not be recorded")
		}
		if marker != nil {
			_, written := marker.Write([]byte("closed"))
			if errors.Join(written, marker.Close()) != nil {
				return errors.New("browser end outcome could not be recorded")
			}
		}
	}
	ctx, end := context.WithTimeout(context.Background(), 10*time.Second)
	defer end()
	browserName, proxyName := browserRuntimeNames(scope.SessionID)
	for _, name := range []string{proxyName, browserName} {
		// Inspect by exact deterministic name and retained ownership. An absent
		// name is confirmed separately; inspection failure is not absence proof.
		ids, err := manager.docker(ctx, "ps", "-aq", "--filter", "name=^/"+name+"$")
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(ids)) == "" {
			continue
		}
		if _, err := manager.inspectOwned(ctx, name, scope); err != nil {
			return err
		}
		if _, err := manager.docker(ctx, "rm", "--force", name); err != nil {
			return err
		}
		remaining, err := manager.docker(ctx, "ps", "-aq", "--filter", "name=^/"+name+"$")
		if err != nil || strings.TrimSpace(string(remaining)) != "" {
			return errors.New("browser container cleanup was not confirmed")
		}
	}
	if runtime != nil && runtime.input != nil {
		runtime.input.Close()
	}
	if runtime != nil && runtime.wait != nil {
		select {
		case <-runtime.wait:
		case <-ctx.Done():
			return errors.New("browser process cleanup was not confirmed")
		}
		runtime.wait = nil
	}
	if err := manager.cleanScreenshot(ctx, scope); err != nil {
		return err
	}
	if runtime != nil {
		runtime.closed = true
		manager.mu.Lock()
		if manager.sessions[scope.SessionID] == runtime {
			delete(manager.sessions, scope.SessionID)
		}
		manager.mu.Unlock()
	}
	return nil
}

func (manager *browserRuntimeManager) closeAll() error {
	manager.mu.Lock()
	all := make([]browserRuntimeRequest, 0, len(manager.sessions))
	for _, runtime := range manager.sessions {
		runtime.cancel()
		all = append(all, runtime.scope)
	}
	manager.mu.Unlock()
	var outcome error
	for _, scope := range all {
		outcome = errors.Join(outcome, manager.closeSession(scope))
	}
	return outcome
}
