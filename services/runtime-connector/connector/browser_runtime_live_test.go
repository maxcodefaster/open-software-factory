package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBrowserRuntimeAppFixture(t *testing.T) {
	if os.Getenv("FACTORY_BROWSER_RUNTIME_APP_FIXTURE") != "1" {
		t.Skip("internal browser runtime App fixture")
	}
	server := &http.Server{Addr: "127.0.0.1:3000", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Exact primary App</title><h1>Only primary loopback</h1><p>Factory browser manager proof</p><script>console.log('primary App inspected')</script>`)
	})}
	defer server.Close()
	if err := server.ListenAndServe(); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserRuntimeCheckoutFixture(t *testing.T) {
	if os.Getenv("FACTORY_BROWSER_RUNTIME_CHECKOUT_FIXTURE") != "1" {
		t.Skip("internal shared checkout fixture")
	}
	workspace := filepath.Join(os.Getenv("FACTORY_BROWSER_FIXTURE_ROOT"), "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "app.html"), []byte("Only primary loopback"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", workspace}, {"-C", workspace, "add", "app.html"}, {"-C", workspace, "-c", "user.name=Owned browser fixture", "-c", "user.email=owned@factory.invalid", "commit", "-m", "Owned exact source context"}} {
		if err := exec.Command("git", args...).Run(); err != nil {
			t.Fatal("owned checkout preparation", err)
		}
	}
}

// The outer test runner has Docker access solely to exercise the parent's fixed
// container commands. Neither browser nor App proxy receives that socket.
func TestBrowserRuntimeManagerFixture(t *testing.T) {
	if os.Getenv("FACTORY_BROWSER_RUNTIME_MANAGER_FIXTURE") != "1" {
		t.Skip("internal browser runtime manager fixture")
	}
	root, owned := os.Getenv("FACTORY_BROWSER_FIXTURE_ROOT"), os.Getenv("FACTORY_BROWSER_FIXTURE_ID")
	assignment := Assignment{
		RuntimeAttemptID: owned, Generation: 7, ComposeProjectName: owned,
		WorkspaceFolder:       filepath.Join(root, "workspace"),
		RemoteWorkspaceFolder: "/tmp/project",
		BrowserToolsImage:     os.Getenv("FACTORY_BROWSER_FIXTURE_IMAGE"), ConnectorStateDir: filepath.Join(root, "runtime"),
		Channels: []Channel{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}},
	}
	manager := newBrowserRuntimeManager(context.Background(), assignment, os.Getenv("FACTORY_BROWSER_FIXTURE_PRIMARY"), "0:0")
	t.Cleanup(func() {
		if err := manager.closeAll(); err != nil {
			t.Error(err)
		}
	})
	connection, disconnect := browserConnectionContext(context.Background())
	defer disconnect()
	scope := browserRuntimeRequest{SessionID: owned, TurnID: "turn-" + owned, AgentSessionID: "ses_fixture",
		OwnerID: strings.Repeat("b", 64), ExpiresAt: time.Now().Add(25 * time.Second)}
	// Exercise real startup across an initial lease, not only fast warm calls.
	// The same controller renewal must keep both fixed containers alive while
	// container creation, MCP initialization and Chrome navigation are in flight.
	opening := scope
	opening.ExpiresAt = time.Now().Add(2 * time.Second)
	opening.Call = browserToolCall{Name: "browser_open", Arguments: json.RawMessage(`{"app":"web"}`)}
	renewContext, stopRenewal := context.WithCancel(connection)
	renewed := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-renewContext.Done():
				renewed <- nil
				return
			case <-ticker.C:
				renewal := opening
				renewal.ExpiresAt = time.Now().Add(25 * time.Second)
				if err := manager.renew(renewal); err != nil {
					renewed <- err
					return
				}
			}
		}
	}()
	_, opened := manager.call(connection, opening)
	stopRenewal()
	if err := <-renewed; err != nil {
		t.Fatal("renewing real browser startup", err)
	}
	if opened != nil {
		t.Fatal("opening real browser across its initial lease", opened)
	}
	call := func(name, arguments string) browserMCPContent {
		t.Helper()
		scope.ExpiresAt = time.Now().Add(25 * time.Second)
		scope.Call = browserToolCall{Name: name, Arguments: json.RawMessage(arguments)}
		output, err := manager.call(connection, scope)
		if err != nil {
			t.Fatal(name, err)
		}
		var result browserMCPContent
		if json.Unmarshal([]byte(output), &result) != nil || result.IsError {
			t.Fatal(name, "browser result unavailable", output)
		}
		return result
	}
	snapshot := call("browser_snapshot", `{}`)
	if len(snapshot.Content) == 0 || !strings.Contains(snapshot.Content[0].Text, "Only primary loopback") {
		t.Fatal("real proxy did not reach the primary's loopback-only App")
	}
	shot := call("browser_screenshot", `{}`)
	if shot.StructuredContent == nil || shot.StructuredContent.TurnID != scope.TurnID || shot.StructuredContent.SessionID != scope.SessionID ||
		shot.StructuredContent.App != "web" || !browserCommitPattern.MatchString(shot.StructuredContent.HeadCommit) || shot.StructuredContent.WorkingTreeModified {
		t.Fatal("exact checkout/App/task observation context unavailable")
	}
	if _, err := manager.docker(context.Background(), "exec", manager.primaryID, "test", "-f", browserScreenshotDirectory(scope.SessionID)+"/screenshot.jpg"); err != nil {
		t.Fatal("parent did not publish the owned screenshot", err)
	}
	for _, content := range shot.Content {
		if content.Type == "image" {
			data, err := base64.StdEncoding.DecodeString(content.Data)
			if err != nil || os.WriteFile(filepath.Join(root, "manager-app.jpg"), data, 0600) != nil {
				t.Fatal("real manager screenshot unavailable", err)
			}
		}
	}
	browserName, proxyName := browserRuntimeNames(scope.SessionID)
	// A compromised browser or proxy cannot extend its own authority by writing
	// the shared lease. Verify the actual mount, not merely create flags.
	for _, name := range []string{browserName, proxyName} {
		output, err := manager.docker(context.Background(), "exec", name, "node", "-e",
			`try{require('fs').writeFileSync('/factory/browser/config/authority.json','{}');process.exit(1)}catch(e){if(e.code!=='EROFS')process.exit(2)}`)
		if err != nil {
			t.Fatal("lease mount was not read-only", name, string(output), err)
		}
	}
	scope.ExpiresAt = time.Now().Add(time.Second)
	if err := manager.renew(scope); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		remaining := len(manager.sessions)
		manager.mu.Unlock()
		if remaining == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	manager.mu.Lock()
	remaining := len(manager.sessions)
	manager.mu.Unlock()
	if remaining != 0 {
		t.Fatal("lease expiry did not confirm owned cleanup")
	}
	if _, err := manager.docker(context.Background(), "exec", manager.primaryID, "test", "!", "-e", browserScreenshotDirectory(scope.SessionID)); err != nil {
		t.Fatal("expired screenshot remained in primary", err)
	}
	if _, err := manager.call(connection, scope); err == nil {
		t.Fatal("expired browser session was resurrected")
	}
	// A fresh session tests disconnect during live browser work independently of
	// the expiry case. Late goroutines must not create after closeAll has finished.
	scope.SessionID += "-stop"
	scope.ExpiresAt = time.Now().Add(25 * time.Second)
	scope.Call = browserToolCall{Name: "browser_open", Arguments: json.RawMessage(`{"app":"web"}`)}
	if _, err := manager.call(connection, scope); err != nil {
		t.Fatal(err)
	}
	scope.Call = browserToolCall{Name: "browser_screenshot", Arguments: json.RawMessage(`{}`)}
	if _, err := manager.call(connection, scope); err != nil {
		t.Fatal(err)
	}
	disconnect()
	if err := manager.closeAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.docker(context.Background(), "exec", manager.primaryID, "test", "!", "-e", browserScreenshotDirectory(scope.SessionID)); err != nil {
		t.Fatal("disconnected screenshot remained in primary", err)
	}
	if response := manager.handle(connection, browserScopeMessage(manager, scope, "browser-call")); response.Error == "" {
		t.Fatal("disconnected execution created a browser")
	}
	evidence, _ := json.Marshal(map[string]any{"primary": manager.primaryID, "image": assignment.BrowserToolsImage,
		"loopbackApp": true, "startupRenewal": true, "authorityReadonly": true, "expiryCleanup": true, "disconnectCleanup": true, "screenshotCleanup": true, "sourceContext": shot.StructuredContent})
	if err := os.WriteFile(filepath.Join(root, "inspection.json"), evidence, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserRuntimeManagerLive(t *testing.T) {
	imageReference := os.Getenv("FACTORY_BROWSER_PROOF_IMAGE")
	parentReference := os.Getenv("FACTORY_BROWSER_PROOF_PARENT_IMAGE")
	if imageReference == "" || parentReference == "" {
		t.Skip("requires explicit browser and parent proof images")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	docker := func(args ...string) string {
		t.Helper()
		output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("Docker %s failed: %v: %s", args[0], err, output)
		}
		return strings.TrimSpace(string(output))
	}
	image := docker("image", "inspect", "--format", "{{.Id}}", imageReference)
	parentImage := docker("image", "inspect", "--format", "{{.Id}}", parentReference)
	owned := "factory-browser-manager-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	root, err := filepath.Abs("../../../.factory/test-results/browser-tools/" + owned)
	if err != nil || os.MkdirAll(root, 0700) != nil {
		t.Fatal("fixture evidence directory unavailable", err)
	}
	primaryName, runnerName, volume := owned+"-primary", owned+"-runner", owned+"-state"
	checkoutName := owned + "-checkout"
	browserName, proxyName := browserRuntimeNames(owned)
	stopBrowser, stopProxy := browserRuntimeNames(owned + "-stop")
	names := []string{browserName, proxyName, stopBrowser, stopProxy, runnerName, primaryName, checkoutName}
	intent, _ := json.Marshal(map[string]any{"fixture": owned, "names": names, "volume": volume, "image": image, "parentImage": parentImage})
	if err := os.WriteFile(filepath.Join(root, "intent.json"), intent, 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup := make(map[string]bool)
		cleanCtx, end := context.WithTimeout(context.Background(), 30*time.Second)
		defer end()
		for _, name := range names {
			ids, err := exec.CommandContext(cleanCtx, "docker", "ps", "-aq", "--filter", "name=^/"+name+"$").Output()
			if err != nil {
				t.Error("fixture cleanup inspection unavailable", err)
				continue
			}
			if strings.TrimSpace(string(ids)) == "" {
				cleanup[name] = true
				continue
			}
			labels, err := exec.CommandContext(cleanCtx, "docker", "inspect", "--format", `{{index .Config.Labels "com.docker.compose.project"}}`, name).Output()
			if err != nil || strings.TrimSpace(string(labels)) != owned {
				t.Error("refusing non-owned fixture cleanup", name)
				continue
			}
			if err := exec.CommandContext(cleanCtx, "docker", "rm", "-f", name).Run(); err != nil {
				t.Error("fixture cleanup failed", name, err)
				continue
			}
			cleanup[name] = true
		}
		labels, err := exec.CommandContext(cleanCtx, "docker", "volume", "inspect", "--format", `{{index .Labels "factory.dev/browser-proof"}}`, volume).Output()
		if err == nil && strings.TrimSpace(string(labels)) == owned {
			if err := exec.CommandContext(cleanCtx, "docker", "volume", "rm", volume).Run(); err != nil {
				t.Error("fixture volume cleanup failed", err)
			} else {
				cleanup[volume] = true
			}
		}
		evidence, _ := json.Marshal(cleanup)
		os.WriteFile(filepath.Join(root, "cleanup.json"), evidence, 0600)
	})
	arch := docker("info", "--format", "{{.Architecture}}")
	if arch == "aarch64" {
		arch = "arm64"
	} else if arch == "x86_64" {
		arch = "amd64"
	} else {
		t.Fatal("unsupported fixture architecture")
	}
	binary := filepath.Join(root, "fixture")
	build := exec.CommandContext(ctx, "go", "test", "-c", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build manager fixture: %v: %s", err, output)
	}
	docker("volume", "create", "--label", "factory.dev/browser-proof="+owned, volume)
	statePath := docker("volume", "inspect", "--format", "{{.Mountpoint}}", volume)
	docker("run", "--rm", "--name", checkoutName, "--label", "com.docker.compose.project="+owned,
		"--mount", "type=volume,src="+volume+",dst="+statePath,
		"--mount", "type=bind,src="+binary+",dst=/test,readonly",
		"--env", "FACTORY_BROWSER_RUNTIME_CHECKOUT_FIXTURE=1", "--env", "FACTORY_BROWSER_FIXTURE_ROOT="+statePath,
		"--entrypoint", "/test", parentImage, "-test.run=^TestBrowserRuntimeCheckoutFixture$", "-test.timeout=30s")
	primaryID := docker("run", "-d", "--name", primaryName, "--label", "com.docker.compose.project="+owned,
		"--label", attemptLabel+"="+owned, "--label", generationLabel+"=7", "--read-only", "--user", "0:0",
		"--tmpfs", "/tmp:rw,nosuid,nodev,size=32m,mode=1777",
		"--mount", "type=bind,src="+filepath.Join(statePath, "workspace")+",dst=/tmp/project",
		"--mount", "type=bind,src="+binary+",dst=/test,readonly", "--env", "FACTORY_BROWSER_RUNTIME_APP_FIXTURE=1",
		"--entrypoint", "/test", "docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20", "-test.run=^TestBrowserRuntimeAppFixture$", "-test.timeout=180s")
	if output, err := exec.CommandContext(ctx, "docker", "exec", primaryID, "git", "--version").CombinedOutput(); err == nil {
		t.Fatal("primary must exercise the no-Git Dev Container", string(output))
	}
	// Use the same exact Docker CLI bundled in Factory's runtime-host, not a
	// downloaded or alternate runtime provider.
	docker("create", "--name", runnerName, "--label", "com.docker.compose.project="+owned,
		"--mount", "type=volume,src="+volume+",dst="+statePath,
		"--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
		"--mount", "type=bind,src="+binary+",dst=/test,readonly",
		"--env", "FACTORY_BROWSER_RUNTIME_MANAGER_FIXTURE=1", "--env", "FACTORY_BROWSER_FIXTURE_ROOT="+statePath,
		"--env", "FACTORY_BROWSER_FIXTURE_ID="+owned, "--env", "FACTORY_BROWSER_FIXTURE_IMAGE="+image,
		"--env", "FACTORY_BROWSER_FIXTURE_PRIMARY="+primaryID, "--entrypoint", "/test", parentImage,
		"-test.run=^TestBrowserRuntimeManagerFixture$", "-test.v", "-test.timeout=120s")
	output, startedErr := exec.CommandContext(ctx, "docker", "start", "--attach", runnerName).CombinedOutput()
	// Retain bounded fixture diagnostics and evidence even if an assertion failed.
	os.WriteFile(filepath.Join(root, "fixture-output.txt"), output, 0600)
	exec.CommandContext(ctx, "docker", "cp", runnerName+":"+statePath+"/.", root).Run()
	if startedErr != nil || docker("inspect", "--format", "{{.State.ExitCode}}", runnerName) != "0" {
		t.Fatalf("actual parent/browser/proxy proof failed: %v: %s", startedErr, output)
	}
	t.Logf("actual joined-primary browser manager proof passed; evidence %s", root)
}
