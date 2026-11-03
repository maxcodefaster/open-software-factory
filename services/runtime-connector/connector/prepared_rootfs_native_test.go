package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Called only by the explicit owned Linux/Compose proof. The actual Parent must
// rebuild with fresh grants without downloading a prepared user-home tool again.
// This proves dependency reuse and required hooks, not Child/App readiness.
func provePreparedRootFSRebuild(t *testing.T, project *preparedProject) time.Duration {
	t.Helper()
	if project == nil {
		t.Fatal("the credential-free template was not prepared")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	target := project.assignment
	target.PreparedImage = nil
	target.EffectiveConfiguration = ""
	target.RuntimeAttemptID = "owned-fresh-rootfs-consumer"
	target.Generation++
	version := uint64(1)
	target.EnvironmentVersion = &version
	target.DeferRuntimeProcesses = false
	observed := make(chan string, 1)
	var environmentRead atomic.Bool
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owned-fresh-parent" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/internal/runtime-environment/"+target.RuntimeAttemptID {
			environmentRead.Store(true)
			json.NewEncoder(w).Encode(runtimeEnvironment{Version: version, Bundle: environmentBundle{
				Variables: []environmentVariable{{Name: "PREPARED_RUNTIME_VALUE", Value: "fresh-after-preparation", Runtime: true}},
			}})
			return
		}
		if r.URL.Path != "/internal/runtime-connect" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				return
			}
			if message.Type != "status" || message.Phase != "child-started" {
				continue
			}
			output, err := exec.CommandContext(ctx, "docker", "ps", "--quiet",
				"--filter", "label="+attemptLabel+"="+target.RuntimeAttemptID,
				"--filter", fmt.Sprintf("label=%s=%d", generationLabel, target.Generation)).Output()
			id := strings.TrimSpace(string(output))
			if err == nil && id != "" && !strings.Contains(id, "\n") {
				output, err = exec.CommandContext(ctx, "docker", "exec", id, "node", "-e",
					`const fs=require('fs'),p=require('os').homedir()+'/.cache/owned-prepared-tool';process.stdout.write(JSON.stringify({tool:fs.readFileSync(p,'utf8'),downloads:fs.readFileSync('/workspace/project/cache-downloads','utf8'),hooks:fs.readFileSync('/workspace/project/project-hook','utf8'),create:fs.readFileSync('/workspace/project/create-hook','utf8'),feature:fs.readFileSync('/workspace/project/feature-hook','utf8')}))`).Output()
			}
			if err != nil {
				observed <- "fresh primary dependency observation failed"
			} else {
				observed <- string(output)
			}
			_ = connection.WriteJSON(Message{Type: "stop"})
			for connection.ReadJSON(&message) == nil {
			}
			return
		}
	}))
	defer endpoint.Close()
	target.ControlURL = strings.Replace(endpoint.URL, "http://", "ws://", 1) + "/internal/runtime-connect"
	started := time.Now()
	err := runParent(ctx, target, "owned-fresh-parent", "owned-fresh-child", project)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("the real Parent could not rebuild its prepared primary: %v", err)
	}
	var values map[string]string
	select {
	case output := <-observed:
		if json.Unmarshal([]byte(output), &values) != nil {
			t.Fatalf("fresh primary observation was unavailable: %s", output)
		}
	default:
		t.Fatal("Parent never confirmed its new primary")
	}
	if values["downloads"] != "download\n" || values["tool"] != "prepared outside the checkout" {
		t.Fatalf("fresh grants discarded prepared primary dependencies and repeated a download: %+v", values)
	}
	if values["hooks"] != "required project hook\nrequired project hook\n" ||
		values["create"] != "required create hook\nrequired create hook\n" ||
		values["feature"] != "required Feature hook\nrequired Feature hook\n" || !environmentRead.Load() {
		t.Fatalf("dependency reuse skipped required hooks or reused captured authority: %+v", values)
	}
	// No protected inputs or Factory authority can be copied into a later
	// template. The source checkout remains private and unchanged.
	if err := checkoutProject(context.Background(), target); err != nil {
		t.Fatalf("prepared dependency reuse lost exact clean source: %v", err)
	}
	if content, err := os.ReadFile(filepath.Join(target.WorkspaceFolder, "dependency/manual")); err != nil || string(content) != "still writable" {
		t.Fatalf("fresh preparation discarded the Fork's separate dependency checkout: %v", err)
	}
	return elapsed
}
