package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestFailedParentStartupKeepsNativePrivateLayersUntilSourceDrain(t *testing.T) {
	for _, scenario := range []string{"retained", "no-actor", "no-source", "disposable", "no-retention", "not-started"} {
		t.Run(scenario, func(t *testing.T) {
			assignment := validAssignment()
			assignment.nativeActorUID = "original-actor"
			assignment.nativeRetainedSource = true
			assignment.nativeSource = http.NotFoundHandler()
			assignment.PreserveWorkspace = true
			failure := errors.New("original bootstrap failed")
			switch scenario {
			case "no-actor":
				assignment.nativeActorUID = ""
			case "no-source":
				assignment.nativeSource = nil
			case "disposable":
				assignment.PreserveWorkspace = false
			case "no-retention":
				assignment.nativeRetainedSource = false
			case "not-started":
				assignment.nativeActorUID = ""
				failure = errDevcontainerNotStarted
			}
			directory := t.TempDir()
			trace := filepath.Join(directory, "docker-trace")
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >>"+fmt.Sprintf("%q", trace)+"\ncase \"$1\" in ps|network|volume) exit 0 ;; *) exit 1 ;; esac\n"), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			if err := cleanupFailedParentStartup(assignment, failure); !errors.Is(err, failure) {
				t.Fatalf("original failure changed: %v", err)
			}
			content, err := os.ReadFile(trace)
			if scenario == "retained" || scenario == "not-started" {
				if !os.IsNotExist(err) || len(content) != 0 {
					t.Fatal("retained/undispatched bootstrap touched private Docker resources")
				}
			} else if err != nil || !strings.HasPrefix(string(content), "ps ") {
				t.Fatal("ordinary failed-start cleanup changed")
			}
		})
	}
}

func TestFailedNativeBootstrapRetainsOnlySourceWithoutReplayingProjectWork(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeActorUID = "original-actor"
	assignment.nativeRetainedSource = true
	assignment.PreserveWorkspace = true
	var reads atomic.Int32
	assignment.nativeSource = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		_, _ = w.Write([]byte("retained Source"))
	})
	directory := t.TempDir()
	trace := filepath.Join(directory, "docker-trace")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >>" + fmt.Sprintf("%q", trace) + "\n[ \"$1\" = ps ] || exit 1\n"
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	var connections atomic.Int32
	observed := make(chan error, 1)
	upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		count := connections.Add(1)
		if count == 1 {
			_, _, _ = connection.ReadMessage()
			return
		}
		check := func() error {
			var hello, status Message
			if err := connection.ReadJSON(&hello); err != nil {
				return err
			}
			if err := connection.ReadJSON(&status); err != nil {
				return err
			}
			if hello.Type != "hello" || status.Type != "status" || status.Phase != "failed" || status.Error != "original bootstrap failed" {
				return errors.New("failure retention advertised readiness or changed its outcome")
			}
			if count == 3 {
				_ = connection.WriteJSON(Message{Type: "operation-request", OperationID: "different-checkpoint", Action: "source-drain"})
				var response Message
				if err := connection.ReadJSON(&response); err != nil {
					return err
				}
				if response.Error == "" {
					return errors.New("reconnect reopened a fenced Source owner")
				}
				return nil
			}
			for _, action := range []string{"workspace-git", "browser-open", "skills-install"} {
				_ = connection.WriteJSON(Message{Type: "operation-request", OperationID: action, Action: action})
				var response Message
				if err := connection.ReadJSON(&response); err != nil {
					return err
				}
				if response.Type != "operation-response" || response.Error == "" {
					return fmt.Errorf("failed bootstrap accepted %s", action)
				}
			}
			_ = connection.WriteJSON(Message{Type: "http-request", StreamID: "source-read", Channel: "source", Method: "GET", Path: "/v1/workspaces/owned/tree"})
			var body strings.Builder
			for {
				var response Message
				if err := connection.ReadJSON(&response); err != nil {
					return err
				}
				if response.Type == "stream-data" {
					data, err := base64.StdEncoding.DecodeString(response.Data)
					if err != nil {
						return err
					}
					body.Write(data)
				}
				if response.Type == "stream-end" {
					break
				}
			}
			if body.String() != "retained Source" {
				return errors.New("failed bootstrap did not retain Source access")
			}
			_ = connection.WriteJSON(Message{Type: "stop"})
			var statusAgain Message
			if err := connection.ReadJSON(&statusAgain); err != nil {
				return err
			}
			if statusAgain.Phase != "failed" {
				return errors.New("transport Stop destroyed unsnapshotted filesystems")
			}
			_ = connection.WriteJSON(Message{Type: "operation-request", OperationID: "original-checkpoint", Action: "source-drain"})
			var drained Message
			if err := connection.ReadJSON(&drained); err != nil {
				return err
			}
			if drained.Error != "" {
				return errors.New(drained.Error)
			}
			return nil
		}
		if err := check(); err != nil {
			observed <- err
			return
		}
		if count == 2 {
			return
		}
		observed <- nil
		_, _, _ = connection.ReadMessage()
	}))
	defer server.Close()
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	control, err := dialControl(ctx, assignment, "parent", "original-capability")
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() {
		completed <- retainParentStartupFailure(ctx, assignment, "original-capability", &control, errors.New("original bootstrap failed"))
	}()
	select {
	case err := <-observed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("retained Source did not complete its bounded protocol proof")
	}
	cancel()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("retained Source ignored cancellation")
	}
	if reads.Load() != 1 {
		t.Fatal("Source read was replayed")
	}
	commands, _ := os.ReadFile(trace)
	if strings.Count(string(commands), "ps ") != 2 || strings.Contains(string(commands), "compose") || strings.Contains(string(commands), "build") {
		t.Fatalf("failure retention repeated Project work: %s", commands)
	}
}
