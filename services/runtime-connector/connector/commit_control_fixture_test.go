package connector

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// Cross-language test entry point, never part of the shipped binary. Factory's
// integration test supplies an owned checkout and drops the native acknowledgement.
// This exercises the actual transport and Git handler, not Dev Container startup.
func TestCommitControlFixture(t *testing.T) {
	raw := os.Getenv("FACTORY_OWNED_COMMIT_ASSIGNMENT")
	if raw == "" {
		t.Skip("requires the owned Factory integration fixture")
	}
	var assignment Assignment
	if err := json.Unmarshal([]byte(raw), &assignment); err != nil {
		t.Fatal(err)
	}
	control, err := dialControl(context.Background(), assignment, "parent", os.Getenv("FACTORY_OWNED_COMMIT_TOKEN"))
	if err != nil {
		t.Fatal(err)
	}
	defer control.close()
	if err := control.write(Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation}); err != nil {
		t.Fatal(err)
	}
	for {
		var message Message
		if err := control.connection.ReadJSON(&message); err != nil {
			return
		}
		if message.Type != "operation-request" {
			t.Fatal("owned commit fixture accepts only parent operations")
		}
		if err := control.write(handleParentOperation(context.Background(), assignment, message)); err != nil {
			return
		}
	}
}
