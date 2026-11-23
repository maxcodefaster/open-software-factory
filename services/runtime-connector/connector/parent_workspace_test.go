package connector

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeWorkspaceFolderUsesCLIResultAndCanonicalCheckout(t *testing.T) {
	for _, test := range []struct {
		name, remote, mount, compose string
	}{
		{"default-image", "/workspaces/project", "/workspaces/project", ""},
		{"custom-image", "/development/python-project", "/development/python-project", ""},
		{"assigned-folder", "/workspace/project", "/workspace/project", ""},
		{"custom-compose", "/development/python-project", "/development/python-project", "owned"},
		{"repository-subdirectory", "/workspaces/project/services/api", "/workspaces/project", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := nativeNetworkFixture(t)
			remote := test.remote
			// Exercise the real CLI up response boundary, not a path derived from
			// user config. Standalone up has no composeProjectName field.
			up := map[string]string{
				"outcome": "success", "containerId": strings.Repeat("b", 64),
				"remoteUser": "vscode", "remoteWorkspaceFolder": remote,
			}
			if test.compose != "" {
				up["composeProjectName"] = test.compose
			}
			// Only primary inspection can supply the checkout root; an extra
			// field in CLI stdout must not become this observation.
			up["checkoutFolder"] = "/unvalidated-cli-value"
			encoded, err := json.Marshal(up)
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("NATIVE_NETWORK_UP_RESULT", string(encoded))
			project := map[string]any{
				"image": "mcr.microsoft.com/devcontainers/python:3.14", "remoteUser": "vscode",
			}
			if remote != "/workspaces/project" {
				project["workspaceFolder"] = remote
			}
			if test.mount != "/workspaces/project" {
				project["workspaceMount"] = "source=${localWorkspaceFolder},target=" + test.mount + ",type=bind"
			}
			if test.compose != "" {
				delete(project, "image")
				delete(project, "workspaceMount")
				project["dockerComposeFile"], project["service"] = "compose.yaml", "workspace"
			}
			configuration, err := json.Marshal(project)
			if err != nil {
				t.Fatal(err)
			}
			configPath := filepath.Join(directory, ".devcontainer", "devcontainer.json")
			if err := os.Mkdir(filepath.Dir(configPath), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(configPath, configuration, 0600); err != nil {
				t.Fatal(err)
			}
			relative, err := filepath.Rel(test.mount, remote)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(directory, relative), 0700); err != nil {
				t.Fatal(err)
			}
			assignment := nativeWorkspaceFolderAssignment(directory)
			// Path admission must not depend on the presence of an Agent.
			// Main's TS consumers separately use the observed Child context.
			assignment.Channels = append(assignment.Channels, Channel{Name: "agent", Kind: "agent"})
			rewriteWorkspaceMount(t, directory, func(primary map[string]any) {
				labels := primary["Config"].(map[string]any)["Labels"].(map[string]any)
				if test.compose == "" {
					delete(labels, "com.docker.compose.project")
				}
				primary["Mounts"] = []map[string]any{{
					"Type": "bind", "Source": directory, "Destination": test.mount, "RW": true,
				}}
			})
			result, err := startDevcontainerWithConfiguration(t.Context(), assignment,
				func(context.Context, Assignment, bool) ([]string, error) { return nil, nil })
			if err != nil {
				t.Fatal("valid CLI up response fixture was rejected", err)
			}
			if result.RemoteWorkspaceFolder != remote || result.ContainerID != strings.Repeat("b", 64) ||
				result.ComposeProjectName != test.compose || result.RemoteUser != "vscode" || result.checkoutFolder != test.mount {
				t.Fatalf("CLI folder or immutable primary changed: %#v", result)
			}
			child := effectiveChildAssignment(assignment, result)
			if child.WorkspaceFolder != remote || child.RemoteWorkspaceFolder != remote || child.CheckoutFolder != test.mount ||
				child.RuntimeAttemptID != assignment.RuntimeAttemptID || child.Generation != assignment.Generation ||
				child.RepositoryIdentity != assignment.RepositoryIdentity || child.Revision != assignment.Revision {
				t.Fatalf("effective Child lost its actual cwd or original owner: %#v", child)
			}
			manager := newProcessManager(t.Context(), child, io.Discard)
			commands := newCommandManager(t.Context(), child, func(Message) error { return nil })
			defer commands.close()
			terminals := newTerminalManager(t.Context(), child, func(Message) error { return nil })
			defer terminals.closeAll()
			if manager.workspace != remote || commands.assignment.WorkspaceFolder != remote ||
				terminals.assignment.WorkspaceFolder != remote {
				t.Fatal("App, command or Terminal cwd did not follow the observed CLI folder")
			}
			if assignment.WorkspaceFolder != directory || assignment.RemoteWorkspaceFolder != "/workspace/project" {
				t.Fatal("observing the container changed canonical Source or admitted runtime intent")
			}
			saved, err := os.ReadFile(configPath)
			if err != nil || string(saved) != string(configuration) {
				t.Fatal("the user's default or explicit folder configuration was rewritten")
			}
			trace, _ := os.ReadFile(filepath.Join(directory, "cli.log"))
			if strings.Count(string(trace), "up ") != 1 || strings.Count(string(trace), "run-user-commands ") != 1 ||
				!strings.Contains(string(trace), "run-user-commands --container-id "+result.ContainerID+" --workspace-folder "+directory) ||
				strings.Count(string(trace), "--config "+configPath) != 2 {
				t.Fatalf("folder observation repeated startup/hooks or replaced the primary: %s", trace)
			}
		})
	}
}

func TestEffectiveChildAssignmentDoesNotInferCheckoutRoot(t *testing.T) {
	assignment := validAssignment()
	assignment.CheckoutFolder = "/unvalidated-parent-value"
	child := effectiveChildAssignment(assignment, devcontainerResult{RemoteWorkspaceFolder: "/workspaces/project/services/api"})
	encoded, err := json.Marshal(child)
	if err != nil {
		t.Fatal(err)
	}
	if child.CheckoutFolder != "" || strings.Contains(string(encoded), `"checkoutFolder"`) {
		t.Fatal("an unobserved checkout root was inherited or inferred from cwd")
	}
	if assignment.CheckoutFolder != "/unvalidated-parent-value" {
		t.Fatal("preparing Child changed Parent intent")
	}
}

func TestNativeWorkspaceFolderRejectsUnprovenSourceBeforeHooks(t *testing.T) {
	for _, scenario := range []string{
		"missing", "foreign-checkout", "checkout-subdirectory", "named-volume", "readonly",
		"duplicate-target", "wrong-target", "relative", "unclean", "root", "different-primary",
		"prefix-sibling", "missing-subdirectory", "file-subdirectory", "symlink-subdirectory",
		"shadowed-volume", "shadowed-subdirectory-bind",
	} {
		t.Run(scenario, func(t *testing.T) {
			directory := nativeNetworkFixture(t)
			remote := "/workspaces/project"
			mount := map[string]any{"Type": "bind", "Source": directory, "Destination": remote, "RW": true}
			mounts := []map[string]any{mount}
			assignment := nativeWorkspaceFolderAssignment(directory)
			switch scenario {
			case "missing":
				mounts = nil
			case "foreign-checkout":
				mount["Source"] = t.TempDir()
			case "checkout-subdirectory":
				subdirectory := filepath.Join(directory, "other")
				if err := os.Mkdir(subdirectory, 0700); err != nil {
					t.Fatal(err)
				}
				mount["Source"] = subdirectory
			case "named-volume":
				mount["Type"], mount["Source"] = "volume", "unrelated-volume"
			case "readonly":
				mount["RW"] = false
			case "duplicate-target":
				mounts = append(mounts, mount)
			case "wrong-target":
				mount["Destination"] = "/another-checkout"
			case "relative":
				remote = "workspaces/project"
			case "unclean":
				remote = "/workspaces/other/../project"
			case "root":
				remote = "/"
			case "prefix-sibling":
				remote += "-other"
			case "missing-subdirectory", "file-subdirectory", "symlink-subdirectory", "shadowed-volume", "shadowed-subdirectory-bind":
				remote += "/services"
				path := filepath.Join(directory, "services")
				switch scenario {
				case "file-subdirectory":
					if err := os.WriteFile(path, []byte("not a directory"), 0600); err != nil {
						t.Fatal(err)
					}
				case "symlink-subdirectory":
					if err := os.Symlink(t.TempDir(), path); err != nil {
						t.Fatal(err)
					}
				case "shadowed-volume", "shadowed-subdirectory-bind":
					if err := os.Mkdir(path, 0700); err != nil {
						t.Fatal(err)
					}
					shadow := map[string]any{"Type": "volume", "Source": "unrelated-volume", "Destination": remote, "RW": true}
					if scenario == "shadowed-subdirectory-bind" {
						shadow["Type"], shadow["Source"] = "bind", path
					}
					mounts = append(mounts, shadow)
				}
			}
			t.Setenv("NATIVE_NETWORK_REMOTE_WORKSPACE", remote)
			rewriteWorkspaceMount(t, directory, func(primary map[string]any) {
				primary["Mounts"] = mounts
				if scenario == "different-primary" {
					primary["Id"] = strings.Repeat("c", 64)
				}
			})
			_, err := startDevcontainerWithConfiguration(t.Context(), assignment,
				func(context.Context, Assignment, bool) ([]string, error) { return nil, nil })
			if err == nil {
				t.Fatal("unconfirmed canonical checkout reached lifecycle dispatch")
			}
			trace, _ := os.ReadFile(filepath.Join(directory, "cli.log"))
			if strings.Count(string(trace), "up ") != 1 || strings.Contains(string(trace), "run-user-commands") {
				t.Fatalf("a rejected CLI workspace ran hooks or repeated up: %s", trace)
			}
		})
	}
}

func nativeWorkspaceFolderAssignment(directory string) Assignment {
	return Assignment{
		RuntimeAttemptID: "owned-attempt", Generation: 1, ComposeProjectName: "owned",
		WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
		RemoteWorkspaceFolder: "/workspace/project", nativeActorUID: "owned-actor",
		RepositoryIdentity: "owned-python-project", Revision: strings.Repeat("c", 40),
		Channels: []Channel{{Name: "ide", Kind: "ide"}, {Name: "app", Kind: "app"}},
	}
}

func rewriteWorkspaceMount(t *testing.T, directory string, change func(map[string]any)) {
	t.Helper()
	path := filepath.Join(directory, "primary")
	content, err := os.ReadFile(path)
	var primary []map[string]any
	if err != nil || json.Unmarshal(content, &primary) != nil || len(primary) != 1 {
		t.Fatal("primary inspection fixture is unavailable", err)
	}
	change(primary[0])
	content, err = json.Marshal(primary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}
