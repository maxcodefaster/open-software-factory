package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Reuse the test executable as the injected Child; only Docker/Dev Containers
// are fixtures. RunParent, RunChild, managed processes and both control sockets
// are the production startup path.
func TestParentInjectedChildProcess(t *testing.T) {
	if os.Getenv("FACTORY_INJECTION_RUN_CHILD") != "1" {
		return
	}
	content, err := os.ReadFile(os.Getenv("FACTORY_INJECTION_ASSIGNMENT"))
	if err != nil {
		t.Fatal(err)
	}
	var assignment Assignment
	var credentials struct {
		Token       string            `json:"token"`
		Environment map[string]string `json:"environment"`
	}
	if json.Unmarshal(content, &assignment) != nil || json.NewDecoder(os.Stdin).Decode(&credentials) != nil {
		t.Fatal("injected Child lost its assignment or stdin capability")
	}
	assignment.RuntimeEnvironment = credentials.Environment
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			if _, err := os.Stat(os.Getenv("FACTORY_INJECTION_CHILD_STOP")); err == nil {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	if err := RunChild(ctx, assignment, credentials.Token); err != nil {
		t.Error(err)
	}
	cancel()
	<-watched
}

func TestParentStartupLanguageCopyCannotBlockChildAndAgent(t *testing.T) {
	for _, scenario := range []string{"blocked-tree", "failed-tree", "blocked-runtime", "failed-runtime"} {
		t.Run(scenario, func(t *testing.T) {
			directory, timeline := injectionTimingFixture(t)
			t.Setenv("FACTORY_INJECTION_RUN_CHILD", "1")
			t.Setenv("FACTORY_INJECTION_EXECUTABLE", os.Args[0])
			t.Setenv("FACTORY_INJECTION_ASSIGNMENT", filepath.Join(directory, "child.json"))
			stopPath := filepath.Join(directory, "child-stop")
			t.Setenv("FACTORY_INJECTION_CHILD_STOP", stopPath)
			step := "languages-tree"
			if strings.HasSuffix(scenario, "-runtime") {
				step = "languages-runtime"
			}
			if strings.HasPrefix(scenario, "blocked-") {
				t.Setenv("FACTORY_INJECTION_CANCEL", step)
			} else {
				t.Setenv("FACTORY_INJECTION_FAIL", step)
			}
			assignment := injectionTimingAssignment()
			assignment.WorkspaceFolder = filepath.Join(directory, "workspace")
			assignment.RemoteWorkspaceFolder = assignment.WorkspaceFolder
			assignment.ConnectorStateDir = filepath.Join(directory, "state")
			assignment.EffectiveConfiguration = filepath.Join(directory, "devcontainer.json")
			preview := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte("preview-remains-usable"))
			}))
			defer preview.Close()
			assignment.Channels = []Channel{{Name: "ide", Kind: "ide"}, {Name: "agent", Kind: "agent"},
				{Name: "app", Kind: "app", Target: preview.URL, HealthPath: "/"}}
			agentPID := filepath.Join(directory, "agent-pid")
			assignment.Processes = []Process{{Name: "agent", Command: []string{
				"/bin/sh", "-c", fmt.Sprintf("printf '%%s' $$ > %q; exec /bin/sleep 30", agentPID),
			}}}
			if err := os.MkdirAll(filepath.Join(assignment.WorkspaceFolder, ".git"), 0700); err != nil {
				t.Fatal(err)
			}
			for name, script := range map[string]string{
				"git":          "#!/bin/sh\ncase \"$*\" in *factory.repositoryIdentity*) printf '%s\\n' '" + assignment.RepositoryIdentity + "';; *rev-parse*) printf main;; esac\n",
				"devcontainer": "#!/bin/sh\nif [ \"$1\" = read-configuration ]; then printf '%s\\n' '{\"configuration\":{},\"mergedConfiguration\":{}}'; else printf '%s\\n' \"$FACTORY_INJECTION_RESULT\"; fi\n",
			} {
				if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			containerID := strings.Repeat("a", 64)
			container, _ := json.Marshal([]map[string]any{{
				"Id": containerID, "State": map[string]bool{"Running": true},
				"Config": map[string]any{"User": "node", "Labels": map[string]string{
					attemptLabel: assignment.RuntimeAttemptID, generationLabel: "1",
				}}, "HostConfig": map[string]any{"CapDrop": []string{"ALL"}},
			}})
			result, _ := json.Marshal(devcontainerResult{Outcome: "success", ContainerID: containerID,
				RemoteUser: "node", RemoteWorkspaceFolder: assignment.WorkspaceFolder})
			t.Setenv("FACTORY_INJECTION_CONTAINER", string(container))
			t.Setenv("FACTORY_INJECTION_RESULT", string(result))
			type observed struct {
				role    string
				message Message
			}
			messages := make(chan observed, 64)
			parents, children := make(chan *websocket.Conn, 2), make(chan *websocket.Conn, 2)
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				role := r.Header.Get("X-Factory-Connector-Role")
				wantToken := "owned-parent-token"
				if role == "child" {
					wantToken = "owned-child-token"
				}
				if r.Header.Get("Authorization") != "Bearer "+wantToken ||
					r.Header.Get("X-Factory-Runtime-Attempt") != assignment.RuntimeAttemptID ||
					r.Header.Get("X-Factory-Runtime-Generation") != "1" {
					http.Error(w, "unadmitted Connector", http.StatusForbidden)
					return
				}
				peer, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer peer.Close()
				if role == "parent" {
					parents <- peer
				} else {
					children <- peer
				}
				for {
					var message Message
					if peer.ReadJSON(&message) != nil {
						return
					}
					messages <- observed{role, message}
				}
			}))
			defer server.Close()
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			assignment.nativeSource = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte("source-remains-usable"))
			})
			ctx, cancel := context.WithCancel(injectionTimingContext(t.Context()))
			done := make(chan error, 1)
			go func() { done <- RunParent(ctx, assignment, "owned-parent-token", "owned-child-token") }()
			joined := false
			defer func() {
				_ = os.WriteFile(stopPath, nil, 0600)
				// Let the real Child reap its managed Agent even if an assertion
				// fails on a host without Linux assigned-process groups.
				for deadline := time.Now().Add(2 * time.Second); ; {
					entries := strings.Join(timeline(), "\n")
					if !strings.Contains(entries, "command:child-start") || strings.Contains(entries, "child-exited") || time.Now().After(deadline) {
						break
					}
					time.Sleep(time.Millisecond)
				}
				cancel()
				if !joined {
					select {
					case <-done:
					case <-time.After(3 * time.Second):
						t.Error("Parent did not join owned startup work")
					}
				}
			}()
			for deadline := time.Now().Add(2 * time.Second); ; {
				if strings.Contains(strings.Join(timeline(), "\n"), "command:"+step) {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("fixture did not reach the selected language copy")
				}
				time.Sleep(time.Millisecond)
			}
			var pending []observed
			await := func(role string, match func(Message) bool, symptom string) Message {
				t.Helper()
				deadline := time.NewTimer(2 * time.Second)
				defer deadline.Stop()
				for {
					for index, got := range pending {
						if got.role == role && match(got.message) {
							pending = append(pending[:index], pending[index+1:]...)
							return got.message
						}
					}
					select {
					case got := <-messages:
						if got.message.Type == "status" && got.message.Phase == "failed" {
							t.Fatalf("%s: Parent failed instead of starting Child: %s", symptom, got.message.Error)
						}
						if got.role == role && match(got.message) {
							return got.message
						}
						pending = append(pending, got)
					case <-deadline.C:
						t.Fatal(symptom)
					}
				}
			}
			await("parent", func(m Message) bool { return m.Phase == "child-started" },
				"blocked language copy prevented real Parent Child startup")
			await("child", func(m Message) bool {
				return m.Type == "process-state" && m.Process == "agent" && m.ProcessState == "running"
			},
				"optional language copy prevented the real Child from starting its Agent process")
			parent, child := <-parents, <-children
			if err := child.WriteJSON(Message{Type: "websocket-open", Channel: "language",
				StreamID: "language-unavailable", Path: "/typescript/owned-workspace"}); err != nil {
				t.Fatal(err)
			}
			language := await("child", func(m Message) bool { return m.StreamID == "language-unavailable" },
				"Child did not report language availability")
			if language.Type != "stream-error" || language.Error == "" {
				t.Fatalf("incomplete language copy claimed readiness: %#v", language)
			}
			if err := child.WriteJSON(Message{Type: "http-request", StreamID: "preview", Channel: "app",
				Method: "GET", Path: "/"}); err != nil {
				t.Fatal(err)
			}
			previewData := await("child", func(m Message) bool { return m.StreamID == "preview" && m.Type == "stream-data" },
				"language failure made Preview unavailable")
			previewBody, _ := base64.StdEncoding.DecodeString(previewData.Data)
			if string(previewBody) != "preview-remains-usable" {
				t.Fatal("Preview response changed")
			}
			if err := parent.WriteJSON(Message{Type: "http-request", StreamID: "source", Channel: "source",
				Method: "GET", Path: "/v1/workspaces/owned/tree"}); err != nil {
				t.Fatal(err)
			}
			data := await("parent", func(m Message) bool { return m.StreamID == "source" && m.Type == "stream-data" },
				"language failure made Source unavailable")
			body, _ := base64.StdEncoding.DecodeString(data.Data)
			if string(body) != "source-remains-usable" {
				t.Fatal("Source response changed")
			}
			if strings.HasPrefix(scenario, "blocked-") {
				// A consumer can log its command before either shell records
				// its PID. Stop only after both deliberately held endpoints
				// exist; cancelling before they start is not a reap failure.
				for deadline := time.Now().Add(2 * time.Second); ; {
					ready := true
					for _, suffix := range []string{"." + step, "." + step + ".consumer"} {
						raw, err := os.ReadFile(os.Getenv("FACTORY_INJECTION_REACHED") + suffix)
						pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
						ready = ready && err == nil && parseErr == nil && pid > 0
					}
					if ready {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("owned copy fixture did not enter its held producer and consumer")
					}
					time.Sleep(time.Millisecond)
				}
			}
			if err := parent.WriteJSON(Message{Type: "stop"}); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				joined = true
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Stop did not join the blocked language copy")
			}
			if strings.HasPrefix(scenario, "blocked-") {
				for _, suffix := range []string{"." + step, "." + step + ".consumer"} {
					raw, err := os.ReadFile(os.Getenv("FACTORY_INJECTION_REACHED") + suffix)
					pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
					if err != nil || parseErr != nil || pid <= 0 {
						t.Fatalf("owned copy fixture did not record %s before Stop: read=%v parse=%v pid=%d", suffix, err, parseErr, pid)
					}
					if signalErr := syscall.Kill(pid, 0); signalErr != syscall.ESRCH {
						t.Fatalf("Stop returned before reaping owned %s pid=%d: %v", suffix, pid, signalErr)
					}
				}
			}
			for deadline := time.Now().Add(2 * time.Second); ; {
				raw, _ := os.ReadFile(agentPID)
				pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
				if pid > 0 && syscall.Kill(pid, 0) == syscall.ESRCH && strings.Contains(strings.Join(timeline(), "\n"), "child-exited") {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("stopped Child left its owned Agent running")
				}
				time.Sleep(time.Millisecond)
			}
			entries := strings.Join(timeline(), "\n")
			if strings.Count(entries, "command:libc-probe") != 1 || strings.Contains(entries, "command:languages-publish") ||
				(step == "languages-tree" && strings.Contains(entries, "command:languages-runtime")) {
				t.Fatal("failed/cancelled language copy probed twice or continued to its runtime copy")
			}
		})
	}
}

func TestParentServesInitializedSourceWhileDockerReadinessIsBlocked(t *testing.T) {
	directory := t.TempDir()
	reached := filepath.Join(directory, "docker-wait")
	if err := os.WriteFile(filepath.Join(directory, "docker"),
		[]byte("#!/bin/sh\n: > \"$FACTORY_SOURCE_DOCKER_WAIT\"\nexec /bin/sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FACTORY_SOURCE_DOCKER_WAIT", reached)
	assignment := validAssignment()
	assignment.nativeSource = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Factory-Writer-Epoch") != "17" || r.Header.Get("Authorization") != "" {
			http.Error(w, "Source authority changed", http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte("current-canonical-source"))
	})
	result := make(chan error, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer peer.Close()
		for _, kind := range []string{"hello", "status"} {
			var message Message
			if err := peer.ReadJSON(&message); err != nil {
				result <- err
				return
			}
			if message.Type != kind {
				result <- errors.New("Parent did not announce its original startup")
				return
			}
		}
		if err := peer.WriteJSON(Message{Type: "http-request", StreamID: "source-before-docker",
			Channel: "source", Method: http.MethodPost, Path: "/v1/workspaces/owned/read",
			Headers: map[string]string{"x-factory-writer-epoch": "17", "authorization": "must-not-forward"},
			Data:    base64.StdEncoding.EncodeToString([]byte(`{"path":"README.md"}`))}); err != nil {
			result <- err
			return
		}
		var body strings.Builder
		for {
			var message Message
			if err := peer.ReadJSON(&message); err != nil {
				result <- err
				return
			}
			switch message.Type {
			case "stream-error":
				result <- errors.New("Source request was rejected before reaching its owner")
				return
			case "stream-data":
				data, err := base64.StdEncoding.DecodeString(message.Data)
				if err != nil {
					result <- err
					return
				}
				body.Write(data)
			case "stream-end":
				if body.String() != "current-canonical-source" {
					result <- errors.New("Parent did not serve its initialized canonical Source")
				} else {
					result <- nil
				}
				_, _, _ = peer.ReadMessage()
				return
			}
		}
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- RunParent(ctx, assignment, "owned-parent-token", "owned-child-token") }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("Parent did not join its canceled Docker readiness check")
		}
	}()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(reached); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture did not reach the blocked Docker check")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("canonical Source remained unavailable behind Docker readiness")
	}
}
