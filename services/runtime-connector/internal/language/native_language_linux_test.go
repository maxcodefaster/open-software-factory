package language

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

// Explicit packaging/component proof: mount the immutable tools image root at
// /opt/factory-tools and a Project TypeScript package at /native-language-typescript.
// Run as a non-root Project user, once with glibc and once with musl. This does
// not claim native Actor admission, browser acceptance or snapshot continuity.
func TestNativeLanguageMountedTools(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_LANGUAGE_PROOF") != "1" {
		t.Skip("requires explicit read-only tools-image packaging fixture")
	}
	libc := os.Getenv("FACTORY_NATIVE_LANGUAGE_PROOF_LIBC")
	if os.Geteuid() == 0 || (libc != "glibc" && libc != "musl") {
		t.Fatal("packaging fixture requires a non-root Project and its expected libc")
	}
	var mount unix.Statfs_t
	if err := unix.Statfs(NativeToolsRoot, &mount); err != nil || mount.Flags&unix.ST_RDONLY == 0 {
		t.Fatalf("tools image is not mounted read-only: %v", err)
	}
	for _, language := range []string{"typescript", "python"} {
		t.Run(language, func(t *testing.T) {
			root := t.TempDir()
			name, languageID := "main.ts", "typescript"
			broken, fixed := "export const amount: number = 'wrong';\n", "export const amount: number = 17;\n"
			if language == "python" {
				name, languageID = "main.py", "python"
				broken, fixed = "amount: int = 'wrong'\n", "amount: int = 17\n"
			} else {
				if err := os.Mkdir(filepath.Join(root, "node_modules"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("/native-language-typescript", filepath.Join(root, "node_modules/typescript")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(`{"compilerOptions":{"strict":true},"include":["*.ts"]}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(root, name)
			if err := os.WriteFile(path, []byte(broken), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			assignment := validAssignment()
			assignment.WorkspaceFolder = root
			assignment.Channels = []protocol.Channel{{Name: "ide", Kind: "ide"}}
			assignment.SetNativeWriters(&writergate.Gate{})
			messages := make(chan protocol.Message, 64)
			manager := NewManager(ctx, assignment, func(message protocol.Message) error {
				select {
				case messages <- message:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			})
			defer manager.CloseAll()
			manager.Attach(protocol.Message{StreamID: language, Path: "/" + language + "/workspace-a"})
			select {
			case message := <-messages:
				if message.Type != "websocket-ready" {
					t.Fatalf("language attach failed: %#v", message)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			manager.mutex.Lock()
			session := manager.sessions[language]
			manager.mutex.Unlock()
			expectedNode := filepath.Join(NativeToolsRoot, libc, "node")
			if session == nil || session.command.Path != expectedNode {
				t.Fatalf("did not select the mounted %s runtime", libc)
			}
			t.Logf("running %s with %s", language, session.command.Path)
			send := func(value any) {
				t.Helper()
				body, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				handled, err := manager.Write(protocol.Message{StreamID: language, MessageType: 1, Data: base64.StdEncoding.EncodeToString(body)})
				if !handled || err != nil {
					t.Fatalf("language input failed: %v", err)
				}
			}
			await := func(match func(map[string]any) bool) {
				t.Helper()
				for {
					select {
					case message := <-messages:
						if message.Type != "websocket-message" {
							t.Fatalf("language session ended unexpectedly: %#v", message)
						}
						body, err := base64.StdEncoding.DecodeString(message.Data)
						var value map[string]any
						if err != nil || json.Unmarshal(body, &value) != nil {
							t.Fatal("malformed language response")
						}
						if match(value) {
							return
						}
					case <-ctx.Done():
						t.Fatalf("language response did not arrive: %v", ctx.Err())
					}
				}
			}
			send(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
				"capabilities": map[string]any{
					"workspace":    map[string]any{"configuration": true},
					"textDocument": map[string]any{"publishDiagnostics": map[string]any{}},
				},
			}})
			await(func(value map[string]any) bool {
				if value["id"] != float64(1) {
					return false
				}
				if value["error"] != nil || value["result"] == nil {
					t.Fatalf("language initialization failed: %v", value)
				}
				return true
			})
			send(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}})
			uri := "factory-workspace://workspace-a/" + name
			send(map[string]any{"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": map[string]any{
				"textDocument": map[string]any{"uri": uri, "languageId": languageID, "version": 1, "text": broken},
			}})
			diagnostics := func(value map[string]any, wantError bool) bool {
				if value["method"] != "textDocument/publishDiagnostics" {
					return false
				}
				params, _ := value["params"].(map[string]any)
				if params["uri"] != uri {
					t.Fatalf("diagnostic escaped its Workspace: %v", params)
				}
				items, ok := params["diagnostics"].([]any)
				if !ok {
					t.Fatal("missing diagnostics")
				}
				if !wantError {
					return len(items) == 0
				}
				for _, item := range items {
					diagnostic, _ := item.(map[string]any)
					text, _ := diagnostic["message"].(string)
					if diagnostic["severity"] == float64(1) && strings.Contains(text, "assign") {
						return true
					}
				}
				return false
			}
			await(func(value map[string]any) bool { return diagnostics(value, true) })
			send(map[string]any{"jsonrpc": "2.0", "method": "textDocument/didChange", "params": map[string]any{
				"textDocument":   map[string]any{"uri": uri, "version": 2},
				"contentChanges": []any{map[string]any{"text": fixed}},
			}})
			await(func(value map[string]any) bool { return diagnostics(value, false) })
			if saved, err := os.ReadFile(path); err != nil || string(saved) != broken {
				t.Fatalf("language edits unexpectedly wrote Project source: %q %v", saved, err)
			}
		})
	}
}
