package language

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func validAssignment() protocol.Assignment {
	return protocol.Assignment{
		Version:               protocol.AssignmentVersion,
		RuntimeAttemptID:      "runtime-test",
		Generation:            1,
		WorkspaceFolder:       "/workspace/outer",
		RemoteWorkspaceFolder: "/workspace/project",
		RepositoryURL:         "file:///factory/source/project.bundle",
		RepositoryIdentity:    "20e65e28-8bad-4c05-a063-3b629808d549",
		Revision:              "main",
		ActorTemplatePath:     ".devcontainer/devcontainer.json",
		ControlURL:            "wss://factory.example.test/runtime/connect",
		Channels: []protocol.Channel{{
			Name:       "app",
			Kind:       "app",
			Target:     "http://127.0.0.1:4300",
			HealthPath: "/health",
		}},
	}
}

func TestLanguageFramingIsBoundedAndPreservesUnicode(t *testing.T) {
	var output bytes.Buffer
	value := map[string]any{"jsonrpc": "2.0", "result": "Grüße 🐍"}
	if err := writeLanguageMessage(&output, value); err != nil {
		t.Fatal(err)
	}
	body, err := readLanguageMessage(bufio.NewReader(&output))
	if err != nil || !strings.Contains(string(body), "Grüße") {
		t.Fatalf("frame: %q %v", body, err)
	}
	for _, input := range []string{
		"Content-Length: 1048577\r\n\r\n",
		"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
		"Content-Length: -1\r\n\r\n",
		strings.Repeat("X", 16<<10),
		"Content-Length: 3\r\n\r\n[]",
	} {
		if _, err := readLanguageMessage(bufio.NewReader(strings.NewReader(input))); err == nil {
			t.Fatal("accepted malformed/oversized frame")
		}
	}
}

func TestLanguageDependencyReadsAreReadOnlyAndBoundToReportedSessionAndAttempt(t *testing.T) {
	dependency := filepath.Join(t.TempDir(), "dependency.py")
	if err := os.WriteFile(dependency, []byte("def amount() -> int:\n    return 17\n"), 0600); err != nil {
		t.Fatal(err)
	}
	session := &languageSession{scope: languageURIs{"workspace-a", "/workspace"}, attemptID: "attempt-a", language: "python", documents: make(map[string]string)}
	virtual, err := session.toEditor("file://" + dependency)
	if err != nil || !strings.HasPrefix(virtual, "factory-language://workspace-a/attempt-a/python/") {
		t.Fatalf("%s %v", virtual, err)
	}
	var response protocol.Message
	manager := NewManager(context.Background(), validAssignment(), func(message protocol.Message) error { response = message; return nil })
	request := func(uri string) map[string]any {
		return map[string]any{"jsonrpc": "2.0", "id": 1, "params": map[string]any{"uri": uri}}
	}
	if err := manager.readDocument("owned", session, request(virtual)); err != nil {
		t.Fatal(err)
	}
	body, _ := base64.StdEncoding.DecodeString(response.Data)
	if !strings.Contains(string(body), "return 17") {
		t.Fatalf("wrong dependency: %s", body)
	}
	for _, uri := range []string{"file://" + dependency, strings.Replace(virtual, "attempt-a", "attempt-b", 1), strings.Replace(virtual, "workspace-a", "workspace-b", 1), virtual + "?other"} {
		if manager.readDocument("owned", session, request(uri)) == nil {
			t.Fatalf("read unreported identity %s", uri)
		}
	}
	other := &languageSession{scope: languageURIs{"workspace-a", "/workspace"}, attemptID: "attempt-a", documents: make(map[string]string)}
	if manager.readDocument("other", other, request(virtual)) == nil {
		t.Fatal("another session adopted a reported document")
	}
	for _, method := range []string{"factory/writeDocument", "factory/execute", "textDocument/formatting"} {
		if allowedLanguageMethod(method) {
			t.Fatalf("unimplemented write operation %s is exposed", method)
		}
	}
}

func TestLanguageURIsKeepExactWorkspaceAndNeverRewriteDocumentText(t *testing.T) {
	scope := languageURIs{"workspace-a", "/workspaces/original"}
	uri := "factory-workspace://workspace-a/src/%C3%BCber.ts"
	actual, err := scope.toRuntime(uri)
	if err != nil || actual != "file:///workspaces/original/src/%C3%BCber.ts" {
		t.Fatalf("%s %v", actual, err)
	}
	reversed, err := scope.toEditor(actual)
	if err != nil || reversed != uri {
		t.Fatalf("%s %v", reversed, err)
	}
	for _, uri := range []string{
		"factory-workspace://workspace-b/src/app.ts",
		"factory-workspace://workspace-a/../secret",
		"factory-workspace://workspace-a/%2e%2e/secret",
		"file:///etc/passwd",
		"factory-workspace://workspace-a/file.ts?other",
	} {
		if _, err := scope.toRuntime(uri); err == nil {
			t.Fatalf("accepted %s", uri)
		}
	}
	for _, uri := range []string{"file:///etc/passwd", "file:///workspaces/original-other/app.ts", "file://other/workspaces/original/app.ts"} {
		if _, err := scope.toEditor(uri); err == nil {
			t.Fatalf("accepted %s", uri)
		}
	}
	text := "const uri = 'factory-workspace://workspace-b/secret';"
	mapped, err := mapLanguageURIs(map[string]any{"textDocument": map[string]any{"uri": uri, "text": text}}, scope.toRuntime, false)
	if err != nil {
		t.Fatal(err)
	}
	document := mapped.(map[string]any)["textDocument"].(map[string]any)
	if document["text"] != text {
		t.Fatal("rewrote source content")
	}
	filtered, err := mapLanguageURIs([]any{map[string]any{"uri": "file:///etc/passwd"}, map[string]any{"uri": actual}}, scope.toEditor, true)
	if err != nil || len(filtered.([]any)) != 1 {
		t.Fatal("external definition escaped its Workspace")
	}
}

type languageBuffer struct{ bytes.Buffer }

func (*languageBuffer) Close() error { return nil }

func TestLanguageClientCannotChooseExecutablesRootsPluginsOrApplyChanges(t *testing.T) {
	manager := NewManager(context.Background(), validAssignment(), func(protocol.Message) error { return nil })
	input := &languageBuffer{}
	session := &languageSession{input: input, scope: languageURIs{"workspace-a", "/workspace"}, writes: make(chan any, 16), done: make(chan struct{})}
	manager.sessions["owned"] = session
	message := func(value any) (bool, error) {
		encoded, _ := json.Marshal(value)
		return manager.Write(protocol.Message{StreamID: "owned", MessageType: 1, Data: base64.StdEncoding.EncodeToString(encoded)})
	}
	handled, err := message(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
		"rootUri": "file:///etc", "rootPath": "/etc", "processId": 42,
		"initializationOptions": map[string]any{"plugins": []any{map[string]any{"name": "arbitrary"}}, "tsserver": map[string]any{"path": "/evil.js"}},
	}})
	if !handled || err != nil {
		t.Fatal(err)
	}
	if err := writeLanguageMessage(input, <-session.writes); err != nil {
		t.Fatal(err)
	}
	body, err := readLanguageMessage(bufio.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "evil") || strings.Contains(string(body), "arbitrary") || strings.Contains(string(body), "/etc") ||
		!strings.Contains(string(body), "file:///workspace") || !strings.Contains(string(body), `"disableAutomaticTypingAcquisition":true`) {
		t.Fatalf("unsafe initialization: %s", body)
	}
	for _, method := range []string{"workspace/executeCommand", "workspace/applyEdit", "workspace/didChangeConfiguration", "client/registerCapability", "unknown"} {
		if _, err := message(map[string]any{"jsonrpc": "2.0", "id": 2, "method": method}); err == nil {
			t.Fatalf("accepted %s", method)
		}
	}
	if _, err := message(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "textDocument/hover", "params": map[string]any{"textDocument": map[string]any{"uri": "factory-workspace://workspace-b/secret"}}}); err == nil {
		t.Fatal("accepted another Workspace")
	}
}

func TestLanguageConfigurationUsesProjectEnvironmentAndStripsRuntimeLoaders(t *testing.T) {
	runtime := NativeToolsRoot + "/musl"
	filtered := languageEnvironment([]string{"PATH=/project/bin", "NODE_OPTIONS=--require=/project/hook.js", "NODE_PATH=/project/modules", "BUN_OPTIONS=--preload=hook", "BUN_INSPECT=1", "PYTHONPATH=/project/deps"}, runtime)
	if len(filtered) != 3 || filtered[0] != "PATH=/project/bin" || filtered[1] != "PYTHONPATH=/project/deps" ||
		filtered[2] != "LD_LIBRARY_PATH=/opt/factory-tools/opt/factory/language-tools/musl/lib" {
		t.Fatal(filtered)
	}
	paths := languageEnvironment([]string{"LD_LIBRARY_PATH=/project/lib", "LD_PRELOAD=/project/loader.so", "LD_AUDIT=/project/audit.so"}, runtime)
	if len(paths) != 1 || paths[0] != "LD_LIBRARY_PATH=/opt/factory-tools/opt/factory/language-tools/musl/lib:/project/lib" {
		t.Fatal(paths)
	}
	session := &languageSession{scope: languageURIs{"workspace-a", t.TempDir()}}
	result := session.configuration(map[string]any{"items": []any{map[string]any{"section": "python.analysis"}, map[string]any{"section": "arbitrary"}}})
	if len(result) != 2 || result[1] != nil || result[0].(map[string]any)["diagnosticMode"] != "openFilesOnly" {
		t.Fatal(result)
	}
	manager := NewManager(context.Background(), validAssignment(), func(message protocol.Message) error {
		if message.Type != "stream-error" {
			t.Fatal("invalid process was started")
		}
		return nil
	})
	manager.Attach(protocol.Message{StreamID: "bad", Path: "/shell/workspace-a"})
	manager.CloseAll()
	if _, err := readLanguageMessage(bufio.NewReader(strings.NewReader(""))); err == nil || err == io.EOF {
		t.Fatal("missing protocol error")
	}
}

func TestLanguageConfigurationUsesTheEffectiveAssignedPythonEnvironment(t *testing.T) {
	root := t.TempDir()
	env := filepath.Join(root, "assigned-environment")
	if err := os.MkdirAll(filepath.Join(env, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env, "bin/python"), []byte("owned interpreter fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIRTUAL_ENV", filepath.Join(root, "image-default"))
	session := &languageSession{scope: languageURIs{"workspace-a", root},
		command: &exec.Cmd{Env: languageEnvironment(procutil.AssignedEnvironment(os.Environ(), map[string]string{"VIRTUAL_ENV": env}), NativeToolsRoot+"/glibc")}}
	values := session.configuration(map[string]any{"items": []any{map[string]any{"section": "python"}}})
	if len(values) != 1 || values[0].(map[string]any)["pythonPath"] != filepath.Join(env, "bin/python") {
		t.Fatal(values)
	}
}

func TestLanguageInputQueueIsOrderedBoundedAndFencedAfterClose(t *testing.T) {
	session := &languageSession{writes: make(chan any, 16), done: make(chan struct{})}
	for index := 0; index < cap(session.writes); index++ {
		if err := session.write(index); err != nil {
			t.Fatal(err)
		}
	}
	if session.write("overflow") == nil {
		t.Fatal("unbounded language queue")
	}
	close(session.done)
	if session.write("after close") == nil {
		t.Fatal("closed session admitted another input")
	}
	for index := 0; index < cap(session.writes); index++ {
		if value := <-session.writes; value != index {
			t.Fatalf("language input reordered: %v != %d", value, index)
		}
	}
}
