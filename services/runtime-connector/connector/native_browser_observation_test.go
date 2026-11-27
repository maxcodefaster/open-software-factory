package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func browserInspectionFixture(t *testing.T) (Assignment, browserRuntimeRequest, Message) {
	t.Helper()
	assignment := Assignment{
		RuntimeAttemptID: "owned-browser-attempt", Generation: 7,
		Channels: []Channel{{Name: "web", Kind: "app"}, {Name: "source", Kind: "source"}},
	}
	scope := browserRuntimeRequest{
		SessionID: "owned-browser-session", TurnID: "owned-browser-turn",
		AgentSessionID: "ses_owned_browser", OwnerID: strings.Repeat("a", 64),
		ExpiresAt: time.Now().Add(20 * time.Second),
		Call:      browserToolCall{Name: "browser-inspection", Arguments: json.RawMessage(`{"app":"web"}`)},
	}
	message := Message{Type: "operation-request", Action: "browser-inspection", OperationID: "owned-observation",
		AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation}
	data, err := json.Marshal(scope)
	if err != nil {
		t.Fatal(err)
	}
	message.Data = string(data)
	return assignment, scope, message
}

func TestBrowserInspectionRequiresExactFreshPrivateScope(t *testing.T) {
	for _, variant := range []string{
		"exact", "attempt", "generation", "empty-attempt", "zero-generation", "operation", "type", "action",
		"expired", "overlong", "session", "turn", "owner", "agent-session", "public-tool",
		"undeclared-app", "non-app-channel", "no-app", "null-arguments", "array-arguments",
		"filesystem", "git-arguments", "fake-commit", "trailing-json", "unknown-scope", "oversize",
	} {
		t.Run(variant, func(t *testing.T) {
			assignment, scope, message := browserInspectionFixture(t)
			switch variant {
			case "attempt":
				message.AttemptID = "another-attempt"
			case "generation":
				message.Generation++
			case "empty-attempt":
				assignment.RuntimeAttemptID, message.AttemptID = "", ""
			case "zero-generation":
				assignment.Generation, message.Generation = 0, 0
			case "operation":
				message.OperationID = ""
			case "type":
				message.Type = "http-request"
			case "action":
				message.Action = "browser-call"
			case "expired":
				scope.ExpiresAt = time.Now().Add(-time.Second)
			case "overlong":
				scope.ExpiresAt = time.Now().Add(31 * time.Second)
			case "session":
				scope.SessionID = "../session"
			case "turn":
				scope.TurnID = ""
			case "owner":
				scope.OwnerID = "foreign"
			case "agent-session":
				scope.AgentSessionID = "foreign"
			case "public-tool":
				scope.Call.Name = "browser_screenshot"
			case "undeclared-app":
				scope.Call.Arguments = json.RawMessage(`{"app":"foreign"}`)
			case "non-app-channel":
				scope.Call.Arguments = json.RawMessage(`{"app":"source"}`)
			case "no-app":
				scope.Call.Arguments = json.RawMessage(`{}`)
			case "null-arguments":
				scope.Call.Arguments = json.RawMessage(`null`)
			case "array-arguments":
				scope.Call.Arguments = json.RawMessage(`[]`)
			case "filesystem":
				scope.Call.Arguments = json.RawMessage(`{"app":"web","path":"/foreign"}`)
			case "git-arguments":
				scope.Call.Arguments = json.RawMessage(`{"app":"web","git":["--git-dir=/foreign"]}`)
			case "fake-commit":
				scope.Call.Arguments = json.RawMessage(`{"app":"web","headCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`)
			}
			data, err := json.Marshal(scope)
			if err != nil {
				t.Fatal(err)
			}
			message.Data = string(data)
			switch variant {
			case "trailing-json":
				message.Data += ` {}`
			case "unknown-scope":
				message.Data = strings.TrimSuffix(message.Data, "}") + `,"workspaceFolder":"/foreign"}`
			case "oversize":
				message.Data += strings.Repeat(" ", 16385)
			}
			observed, app, err := decodeBrowserInspectionRequest(message, assignment)
			if variant != "exact" {
				if err == nil {
					t.Fatal("unadmitted inspection scope reached the Source reader")
				}
				return
			}
			if err != nil || app != "web" || !sameBrowserScope(observed, scope) {
				t.Fatalf("private scope rejected or changed: %q %+v %v", app, observed, err)
			}
		})
	}
}

func TestBrowserCheckoutContextReadsActualGitWithoutHooksFsmonitorOrIndexWrites(t *testing.T) {
	workspace, commit := commitRepository(t)
	assignment, scope, _ := browserInspectionFixture(t)
	assignment.WorkspaceFolder = workspace
	hooks := t.TempDir()
	marker := filepath.Join(hooks, "executed")
	for _, name := range []string{"fsmonitor", "post-index-change", "pre-auto-gc", "post-checkout"} {
		body := "#!/bin/sh\nprintf executed >> " + "'" + marker + "'\nprintf 'owned-token\\000'\n"
		if err := os.WriteFile(filepath.Join(hooks, name), []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	commitGit(t, workspace, "config", "core.fsmonitor", filepath.Join(hooks, "fsmonitor"))
	commitGit(t, workspace, "config", "core.hooksPath", hooks)
	// Inherited Git settings must not redirect the Source or re-enable helpers.
	foreign, _ := commitRepository(t)
	t.Setenv("GIT_DIR", filepath.Join(foreign, ".git"))
	t.Setenv("GIT_WORK_TREE", foreign)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(foreign, ".git/index"))
	t.Setenv("GIT_CONFIG_COUNT", "2")
	t.Setenv("GIT_CONFIG_KEY_0", "core.fsmonitor")
	t.Setenv("GIT_CONFIG_VALUE_0", filepath.Join(hooks, "fsmonitor"))
	t.Setenv("GIT_CONFIG_KEY_1", "core.hooksPath")
	t.Setenv("GIT_CONFIG_VALUE_1", hooks)
	index := filepath.Join(workspace, ".git/index")
	old := time.Unix(1_600_000_000, 0)
	if err := os.Chtimes(index, old, old); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	// A pre-existing writer lock must not be acquired, removed or overwritten.
	lock := filepath.Join(workspace, ".git/index.lock")
	if err := os.WriteFile(lock, []byte("owned pending writer"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"clean", "tracked-dirty", "untracked-dirty"} {
		t.Run(variant, func(t *testing.T) {
			if variant == "tracked-dirty" {
				commitFile(t, workspace, "app.txt", "actual dirty source\n")
			}
			if variant == "untracked-dirty" {
				commitFile(t, workspace, "app.txt", "base\n")
				commitFile(t, workspace, "manual.txt", "actual untracked source\n")
			}
			started := time.Now()
			observed, err := readBrowserCheckoutContext(t.Context(), assignment, scope, "web")
			if err != nil {
				t.Fatal(err)
			}
			if observed.HeadCommit != commit.ExpectedSHA || observed.WorkingTreeModified != (variant != "clean") ||
				observed.App != "web" || observed.AttemptID != assignment.RuntimeAttemptID ||
				observed.Generation != assignment.Generation || observed.SessionID != scope.SessionID || observed.TurnID != scope.TurnID {
				t.Fatalf("incorrect actual Source context: %+v", observed)
			}
			at, err := time.Parse(time.RFC3339Nano, observed.ObservedAt)
			if err != nil || at.Before(started) || at.After(time.Now()) {
				t.Fatalf("observation timestamp is not fresh: %q %v", observed.ObservedAt, err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("read-only inspection executed repository hooks/fsmonitor", err)
			}
			after, err := os.ReadFile(index)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("read-only inspection changed index bytes", err)
			}
			afterInfo, err := os.Stat(index)
			if err != nil || !os.SameFile(info, afterInfo) || !info.ModTime().Equal(afterInfo.ModTime()) ||
				info.Mode() != afterInfo.Mode() {
				t.Fatal("read-only inspection replaced or wrote the index", err)
			}
			if data, err := os.ReadFile(lock); err != nil || string(data) != "owned pending writer" {
				t.Fatal("read-only inspection touched an existing writer lock", err)
			}
		})
	}
}

func TestBrowserCheckoutContextRejectsUnadmittedPathsAppsAndCancelledReads(t *testing.T) {
	workspace, _ := commitRepository(t)
	assignment, scope, _ := browserInspectionFixture(t)
	for _, variant := range []string{"relative", "unclean", "symlink", "undeclared-app", "non-app", "cancelled", "not-a-checkout", "nested-not-root"} {
		t.Run(variant, func(t *testing.T) {
			current := assignment
			current.WorkspaceFolder = workspace
			app := "web"
			ctx := t.Context()
			switch variant {
			case "relative":
				current.WorkspaceFolder = "project"
			case "unclean":
				current.WorkspaceFolder = workspace + "/."
			case "symlink":
				current.WorkspaceFolder = filepath.Join(t.TempDir(), "project")
				if err := os.Symlink(workspace, current.WorkspaceFolder); err != nil {
					t.Fatal(err)
				}
			case "undeclared-app":
				app = "foreign"
			case "non-app":
				app = "source"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "not-a-checkout":
				current.WorkspaceFolder = t.TempDir()
			case "nested-not-root":
				current.WorkspaceFolder = filepath.Join(workspace, "nested")
				if err := os.Mkdir(current.WorkspaceFolder, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if observed, err := readBrowserCheckoutContext(ctx, current, scope, app); err == nil || observed != nil {
				t.Fatalf("unadmitted Source inspection succeeded: %+v %v", observed, err)
			}
		})
	}
}

func TestBrowserInspectionCannotBypassSourceFence(t *testing.T) {
	assignment, _, message := browserInspectionFixture(t)
	var fence parentSourceFence
	reads := 0
	handle := fence.Wrap(func(_ context.Context, request Message) Message {
		if request.Action == "browser-inspection" {
			if _, _, err := decodeBrowserInspectionRequest(request, assignment); err != nil {
				t.Fatal(err)
			}
			reads++
		}
		return Message{Type: "operation-response", OperationID: request.OperationID, Action: request.Action}
	})
	if reply := handle(t.Context(), message); reply.Error != "" || reads != 1 {
		t.Fatal("unfenced private operation failed", reply)
	}
	if reply := handle(t.Context(), Message{Action: "source-drain", OperationID: "owned-checkpoint"}); reply.Error != "" {
		t.Fatal(reply)
	}
	if reply := handle(t.Context(), message); reply.Error == "" || reply.Data != "" || reads != 1 {
		t.Fatal("inspection bypassed Source drain", reply)
	}
}

func TestBrowserObservationUsesTheExactAdmittedSourceWithoutProjectGit(t *testing.T) {
	workspace, commit := commitRepository(t)
	assignment, scope, _ := browserInspectionFixture(t)
	assignment.WorkspaceFolder = workspace
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
	observation, err := readBrowserCheckoutContext(context.Background(), assignment, scope, "web")
	if err != nil {
		t.Fatal(err)
	}
	if observation.HeadCommit != commit.ExpectedSHA || !observation.WorkingTreeModified || observation.App != "web" ||
		observation.SessionID != scope.SessionID || observation.TurnID != scope.TurnID ||
		observation.AttemptID != assignment.RuntimeAttemptID || observation.Generation != assignment.Generation {
		t.Fatalf("incorrect actual Source context: %+v", observation)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("read-only inspection executed repository fsmonitor")
	}
	indexAfter, err := os.ReadFile(filepath.Join(workspace, ".git", "index"))
	if err != nil || string(indexAfter) != string(indexBefore) {
		t.Fatal("inspection modified the index")
	}
}
