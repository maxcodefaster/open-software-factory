package connector

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParentOperationCannotForgeNativeWorkDrainOrFallBackToDocker(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, "private-daemon-was-called")
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte("#!/bin/sh\n: > '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	assignment := validAssignment()
	assignment.SetNativeSource(http.NotFoundHandler())
	for _, data := range []string{"", "checkpoint-a"} {
		response := handleParentOperation(t.Context(), assignment, Message{
			OperationID: "checkpoint-a", Action: "source-drain", Data: data,
		})
		if !strings.Contains(response.Error, "native Work writer barrier") {
			t.Fatalf("generic Parent acknowledged an unproven native drain: %#v", response)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("Source drain reached the removed private Docker engine")
	}
}

func TestParentSourceFenceDrainsConcurrentWritersAndRejectsLateOperations(t *testing.T) {
	var fence parentSourceFence
	entered, release, drained := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var writes atomic.Int32
	handle := fence.Wrap(func(_ context.Context, message Message) Message {
		if message.Action == "browser-call" {
			close(entered)
			<-release
			writes.Add(1)
		} else if message.Action == "source-drain" {
			close(drained)
		} else {
			writes.Add(1)
		}
		return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	})
	ctx := context.Background()
	writerDone := make(chan struct{})
	go func() {
		handle(ctx, Message{Action: "browser-call", OperationID: "in-flight"})
		close(writerDone)
	}()
	<-entered
	drainDone := make(chan Message, 1)
	go func() { drainDone <- handle(ctx, Message{Action: "source-drain", OperationID: "checkpoint-a"}) }()
	select {
	case <-drained:
		t.Fatal("Source drain raced a still-running browser operation")
	default:
	}
	close(release)
	<-writerDone
	select {
	case reply := <-drainDone:
		if reply.Error != "" || writes.Load() != 1 {
			t.Fatal("Source drain did not settle the earlier writer")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Source drain did not finish after its writer settled")
	}
	for _, action := range []string{"workspace-git", "git-prepare-commit", "git-push", "skills-install", "browser-call", "browser-renew", "browser-recording-start"} {
		if reply := handle(ctx, Message{Action: action, OperationID: "late"}); reply.Error == "" {
			t.Fatalf("late %s bypassed the Source writer fence", action)
		}
	}
	if writes.Load() != 1 {
		t.Fatal("a late operation reached the writer after drain")
	}
}

func TestParentSourceFenceRetainsCheckpointAfterFailedOrLostDrainReply(t *testing.T) {
	var fence parentSourceFence
	var calls int
	handle := fence.Wrap(func(_ context.Context, message Message) Message {
		calls++
		return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "owned drain failure"}
	})
	ctx := context.Background()
	if reply := handle(ctx, Message{Action: "source-drain"}); reply.Error == "" || calls != 0 {
		t.Fatal("a drain without checkpoint identity was admitted")
	}
	for range 2 {
		handle(ctx, Message{Action: "source-drain", OperationID: "checkpoint-a"})
	}
	if calls != 2 {
		t.Fatal("the same recorded drain could not be reconciled")
	}
	for _, message := range []Message{{Action: "source-drain", OperationID: "checkpoint-b"}, {Action: "workspace-git", OperationID: "late"}} {
		if reply := handle(ctx, message); reply.Error != "Source writers are fenced for the recorded checkpoint" {
			t.Fatal("a failed drain lost its original writer fence")
		}
	}
	if calls != 2 {
		t.Fatal("a different operation was dispatched after the uncertain drain")
	}
}
