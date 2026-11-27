package connector

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
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
