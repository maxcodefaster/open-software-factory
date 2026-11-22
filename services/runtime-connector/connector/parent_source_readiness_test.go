package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

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
