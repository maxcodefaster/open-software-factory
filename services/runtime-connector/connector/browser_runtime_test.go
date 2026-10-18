package connector

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type browserDiscardInput struct{ io.Writer }

func (browserDiscardInput) Close() error { return nil }

func TestBrowserFailedNavigationDoesNotClaimCheckoutOrAppContext(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	directory := manager.directory(scope.SessionID)
	if err := os.MkdirAll(filepath.Join(directory, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &browserRuntime{scope: scope, directory: directory, ctx: ctx, cancel: cancel,
		command: &exec.Cmd{}, input: browserDiscardInput{io.Discard}, responses: make(chan browserMCPReply, 1)}
	runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Declared App navigation exceeded its deadline"}]}`)}
	manager.sessions[scope.SessionID] = runtime
	manager.docker = func(context.Context, ...string) ([]byte, error) {
		t.Error("failed navigation inspected the checkout as though the App had loaded")
		return nil, errors.New("unexpected inspection")
	}
	output, err := manager.call(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	var result browserMCPContent
	if json.Unmarshal([]byte(output), &result) != nil || !result.IsError || result.StructuredContent != nil ||
		len(result.Content) != 1 || result.Content[0].Text != "Declared App navigation exceeded its deadline" {
		t.Fatalf("failed navigation claimed an observation: %s", output)
	}
}

func TestBrowserRenewalCanKeepAnInFlightCallAlive(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	manager.docker = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	scope.ExpiresAt = time.Now().Add(300 * time.Millisecond)
	directory := manager.directory(scope.SessionID)
	if err := os.MkdirAll(filepath.Join(directory, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeBrowserAuthority(directory, scope); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &browserRuntime{scope: scope, directory: directory, ctx: ctx, cancel: cancel,
		command: &exec.Cmd{}, input: browserDiscardInput{io.Discard}, responses: make(chan browserMCPReply, 1)}
	manager.sessions[scope.SessionID] = runtime
	lease, end, err := browserAuthorityContext(ctx, filepath.Join(directory, "config", "authority.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	go func() {
		<-lease.Done()
		cancel()
	}()
	done := make(chan error, 1)
	go func() {
		_, err := manager.call(ctx, scope)
		done <- err
	}()
	// Wait until the actual call owns the browser lock, as during cold startup
	// or a slow page load. Renewal must not queue behind that same call.
	deadline := time.Now().Add(100 * time.Millisecond)
	for runtime.mu.TryLock() {
		runtime.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("browser call did not start")
		}
		time.Sleep(time.Millisecond)
	}
	renewed := make(chan error, 1)
	renewal := scope
	renewal.ExpiresAt = time.Now().Add(25 * time.Second)
	go func() { renewed <- manager.renew(renewal) }()
	select {
	case err := <-renewed:
		if err != nil {
			t.Fatal("renewal failed", err)
		}
	case err := <-done:
		t.Fatalf("browser execution authority ended while an authorized renewal waited: %v", err)
	case <-time.After(time.Second):
		t.Fatal("renewal blocked behind the browser call")
	}
	// Return a known tool error so no checkout or browser identity is fabricated.
	runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"fixture observation"}]}`)}
	if err := <-done; err != nil {
		t.Fatal("renewed browser call failed", err)
	}
}

func TestBrowserOpenAllowsColdChromeStartupBeforeItsNavigationDeadline(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	manager.docker = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	t.Cleanup(func() {
		if err := manager.closeAll(); err != nil {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &browserRuntime{scope: scope, directory: manager.directory(scope.SessionID),
		ctx: ctx, cancel: cancel, command: &exec.Cmd{}, input: browserDiscardInput{io.Discard},
		responses: make(chan browserMCPReply, 1)}
	manager.sessions[scope.SessionID] = runtime
	// new_page's ten-second navigation deadline does not include cold Chrome
	// launch. Exercise the real RPC wait rather than only testing a duration.
	go func() {
		select {
		case <-time.After(16 * time.Second):
			runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Known fixture navigation outcome after cold launch"}]}`)}
		case <-ctx.Done():
		}
	}()
	if _, err := manager.call(ctx, scope); err != nil {
		t.Fatalf("cold browser_open was interrupted before its known result: %v", err)
	}
}

func TestBrowserObservationUsesTheExactSharedCheckoutWithoutPrimaryGit(t *testing.T) {
	workspace, commit := commitRepository(t)
	manager, scope := browserRuntimeFixture(t)
	manager.assignment.WorkspaceFolder = workspace
	manager.assignment.RemoteWorkspaceFolder = "/workspace/project"
	commitFile(t, workspace, "manual.txt", "Owned manual edit\n")
	marker := filepath.Join(t.TempDir(), "helper-ran")
	helper := filepath.Join(t.TempDir(), "fsmonitor")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	commitGit(t, workspace, "config", "core.fsmonitor", helper)
	indexBefore, err := os.ReadFile(filepath.Join(workspace, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"exact", "foreign-source", "git-overlay", "readonly", "missing"} {
		t.Run(variant, func(t *testing.T) {
			source := workspace
			if variant == "foreign-source" {
				source = filepath.Dir(workspace)
			}
			mounts := []map[string]any{{"Type": "bind", "Source": source, "Destination": "/workspace/project", "RW": variant != "readonly"}}
			if variant == "missing" {
				mounts = nil
			}
			if variant == "git-overlay" {
				mounts = append(mounts, map[string]any{"Type": "volume", "Source": "foreign-git", "Destination": "/workspace/project/.git", "RW": true})
			}
			manager.docker = func(_ context.Context, args ...string) ([]byte, error) {
				if len(args) != 2 || args[0] != "inspect" || args[1] != manager.primaryID {
					t.Fatal("assumed optional Git inside primary", args)
				}
				return json.Marshal([]map[string]any{{"Id": manager.primaryID, "State": map[string]any{"Running": true},
					"Config": map[string]any{"Labels": map[string]string{attemptLabel: manager.assignment.RuntimeAttemptID, generationLabel: "3", "com.docker.compose.project": manager.assignment.ComposeProjectName}}, "Mounts": mounts}})
			}
			context, err := manager.observationContext(context.Background(), scope, "web")
			if variant != "exact" {
				if err == nil {
					t.Fatal("accepted an unconfirmed checkout mount")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if context.HeadCommit != commit.ExpectedSHA || !context.WorkingTreeModified || context.App != "web" {
				t.Fatalf("incorrect actual source context: %+v", context)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("read-only inspection executed repository fsmonitor")
			}
			indexAfter, err := os.ReadFile(filepath.Join(workspace, ".git", "index"))
			if err != nil || string(indexAfter) != string(indexBefore) {
				t.Fatal("inspection modified the index")
			}
		})
	}
}

func browserRuntimeFixture(t *testing.T) (*browserRuntimeManager, browserRuntimeRequest) {
	t.Helper()
	assignment := Assignment{
		RuntimeAttemptID: "attempt-browser-test", Generation: 3, ComposeProjectName: "factory-browser-test",
		BrowserToolsImage: "sha256:" + strings.Repeat("a", 64), ConnectorStateDir: t.TempDir(),
		Channels: []Channel{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}},
	}
	scope := browserRuntimeRequest{
		SessionID: "browser-test", TurnID: "turn-test", AgentSessionID: "ses_test",
		OwnerID: strings.Repeat("b", 64), ExpiresAt: time.Now().Add(20 * time.Second),
		Call: browserToolCall{Name: "browser_open", Arguments: json.RawMessage(`{"app":"web"}`)},
	}
	return newBrowserRuntimeManager(context.Background(), assignment, strings.Repeat("c", 64), "0:0"), scope
}

func browserScopeMessage(manager *browserRuntimeManager, scope browserRuntimeRequest, action string) Message {
	data, _ := json.Marshal(scope)
	return Message{Action: action, OperationID: "operation-test", AttemptID: manager.assignment.RuntimeAttemptID,
		Generation: manager.assignment.Generation, Data: string(data)}
}

func TestBrowserRuntimeExecutionScope(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	valid := browserScopeMessage(manager, scope, "browser-call")
	if _, err := decodeBrowserRuntimeRequest(valid, manager.assignment); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Message){
		func(m *Message) { m.AttemptID = "other-attempt" },
		func(m *Message) { m.Generation++ },
		func(m *Message) { m.OperationID = "" },
		func(m *Message) { m.Data = strings.Replace(m.Data, scope.OwnerID, "raw-secret", 1) },
		func(m *Message) { m.Data = strings.Replace(m.Data, scope.SessionID, "../escape", 1) },
		func(m *Message) { m.Data += `{}` },
		func(m *Message) { m.Data = strings.Replace(m.Data, `"turnId"`, `"unapproved"`, 1) },
	} {
		invalid := valid
		change(&invalid)
		if _, err := decodeBrowserRuntimeRequest(invalid, manager.assignment); err == nil {
			t.Fatalf("accepted invalid scope: %+v", invalid)
		}
	}
	for _, expiry := range []time.Time{time.Now().Add(-time.Second), time.Now().Add(time.Minute)} {
		scope.ExpiresAt = expiry
		if _, err := decodeBrowserRuntimeRequest(browserScopeMessage(manager, scope, "browser-call"), manager.assignment); err == nil {
			t.Fatal("accepted expired or excessive lease")
		}
		if _, err := decodeBrowserRuntimeRequest(browserScopeMessage(manager, scope, "browser-close"), manager.assignment); err != nil {
			t.Fatal("must allow exact owned cleanup after expiry", err)
		}
	}
}

func TestBrowserRuntimeDisconnectedRequestCannotCreate(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	manager.docker = func(context.Context, ...string) ([]byte, error) {
		t.Error("disconnected request reached Docker")
		return nil, errors.New("unexpected create")
	}
	connection, disconnect := context.WithCancel(context.Background())
	disconnect()
	if err := manager.closeAll(); err != nil {
		t.Fatal(err)
	}
	// Simulate an old dispatched goroutine being scheduled after disconnect cleanup.
	if response := manager.handle(connection, browserScopeMessage(manager, scope, "browser-call")); response.Error == "" {
		t.Fatal("late request was accepted")
	}
	if _, err := manager.call(connection, scope); err == nil || len(manager.sessions) != 0 {
		t.Fatal("late request allocated a session")
	}
	if entries, err := os.ReadDir(manager.assignment.ConnectorStateDir); err != nil || len(entries) != 0 {
		t.Fatal("late request touched runtime state", err)
	}
}

func browserIsolationFixture(t *testing.T, manager *browserRuntimeManager, directory string, proxy bool) inspectedContainer {
	t.Helper()
	arguments, err := browserCreateArguments(manager.assignment, manager.primaryID, directory, browserRuntimeRequest{SessionID: "browser-test"}, proxy)
	if err != nil {
		t.Fatal(err)
	}
	network := "none"
	if proxy {
		network = "container:" + manager.primaryID
	}
	if !strings.Contains(strings.Join(arguments, " "), "--network "+network) {
		t.Fatal("create command lost network boundary")
	}
	var container inspectedContainer
	encoded, _ := json.Marshal(map[string]any{
		"Config": map[string]any{"Image": manager.assignment.BrowserToolsImage, "User": "1000:1000"},
		"HostConfig": map[string]any{"NetworkMode": network, "ReadonlyRootfs": true,
			"CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges=true"},
			"Tmpfs":  map[string]string{"/tmp": "rw,nosuid,nodev,size=256m,mode=1777"},
			"Memory": 768 << 20, "NanoCpus": 1_000_000_000, "PidsLimit": 256},
		"Mounts": []map[string]any{
			{"Type": "bind", "Source": filepath.Join(directory, "socket"), "Destination": "/factory/browser", "RW": proxy},
			{"Type": "bind", "Source": filepath.Join(directory, "config"), "Destination": "/factory/browser/config", "RW": false},
		},
	})
	if err := json.Unmarshal(encoded, &container); err != nil {
		t.Fatal(err)
	}
	return container
}

func TestBrowserRuntimeRecoveredIsolation(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	directory := manager.directory(scope.SessionID)
	for _, proxy := range []bool{false, true} {
		good := browserIsolationFixture(t, manager, directory, proxy)
		if err := validateBrowserIsolation(good, manager.assignment, manager.primaryID, directory, proxy); err != nil {
			t.Fatal(err)
		}
		for _, alter := range []func(*inspectedContainer){
			func(c *inspectedContainer) { c.HostConfig.NetworkMode = "host" },
			func(c *inspectedContainer) { c.HostConfig.PidMode = "host" },
			func(c *inspectedContainer) { c.HostConfig.Privileged = true },
			func(c *inspectedContainer) { c.HostConfig.ReadonlyRootfs = false },
			func(c *inspectedContainer) { c.Config.User = "0" },
			func(c *inspectedContainer) { c.Config.Image = "mutable:latest" },
			func(c *inspectedContainer) { c.HostConfig.CapAdd = []string{"SYS_ADMIN"} },
			func(c *inspectedContainer) { c.HostConfig.SecurityOpt = []string{"seccomp=unconfined"} },
			func(c *inspectedContainer) { c.HostConfig.Memory = 0 },
			func(c *inspectedContainer) { c.Mounts[1].RW = true },
			func(c *inspectedContainer) { c.Mounts[0].Source = "/checkout" },
		} {
			bad := browserIsolationFixture(t, manager, directory, proxy)
			alter(&bad)
			if err := validateBrowserIsolation(bad, manager.assignment, manager.primaryID, directory, proxy); err == nil {
				t.Fatal("accepted recovered container with changed isolation")
			}
		}
	}
}

func TestBrowserRuntimeCleanupMustBeConfirmed(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	live, cancel := context.WithCancel(context.Background())
	runtime := &browserRuntime{scope: scope, ctx: live, cancel: cancel}
	manager.sessions[scope.SessionID] = runtime
	manager.docker = func(context.Context, ...string) ([]byte, error) { return nil, errors.New("daemon unavailable") }
	if err := manager.closeAll(); err == nil || runtime.ctx.Err() == nil || len(manager.sessions) != 1 {
		t.Fatal("unconfirmed cleanup was lost or authority remained live")
	}
	manager.docker = func(_ context.Context, args ...string) ([]byte, error) {
		if !reflect.DeepEqual(args[:2], []string{"ps", "-aq"}) {
			t.Fatal("absent container should not be removed", args)
		}
		return nil, nil
	}
	if err := manager.closeAll(); err != nil || len(manager.sessions) != 0 {
		t.Fatal("confirmed cleanup was not retained", err)
	}
	if _, err := manager.call(context.Background(), scope); err == nil {
		t.Fatal("closed session was resurrected")
	}
}

func TestBrowserRuntimeCleanupRejectsForeignOwner(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	live, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager.sessions[scope.SessionID] = &browserRuntime{scope: scope, ctx: live, cancel: cancel}
	foreign := scope
	foreign.OwnerID = strings.Repeat("e", 64)
	if err := manager.closeSession(foreign); err == nil || live.Err() != nil {
		t.Fatal("foreign owner revoked the session")
	}
	manager.sessions = make(map[string]*browserRuntime)
	directory := manager.directory(scope.SessionID)
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	recorded, _ := json.Marshal(scope)
	if err := os.WriteFile(filepath.Join(directory, "scope.json"), recorded, 0400); err != nil {
		t.Fatal(err)
	}
	if err := manager.closeSession(foreign); err == nil {
		t.Fatal("foreign owner changed retained session outcome")
	}
	if _, err := os.Stat(filepath.Join(directory, "ended")); !os.IsNotExist(err) {
		t.Fatal("foreign cleanup changed local outcome")
	}
}
