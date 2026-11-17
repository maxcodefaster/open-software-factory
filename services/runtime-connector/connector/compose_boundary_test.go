package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComposeValidationRefusesHostBoundariesAndForeignFiles(t *testing.T) {
	root := t.TempDir()
	config := filepath.Join(root, ".devcontainer", "devcontainer.json")
	inside := filepath.Join(root, "token.txt")
	if err := os.WriteFile(inside, []byte("project secret"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	validate := func(document string) error {
		script := "#!/bin/sh\ncat <<'EOF'\n" + document + "\nEOF\n"
		if err := os.WriteFile(filepath.Join(root, "docker"), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		_, err := validateCompose(context.Background(), Assignment{WorkspaceFolder: root}, config,
			"compose.json", "workspace", nil)
		return err
	}
	service := func(extra string) string {
		return `{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]` + extra + `}}}`
	}
	if err := validate(service(`,"ipc":"shareable","volumes_from":["service:other"]`)); err != nil {
		t.Fatalf("rejected a Compose project inside its boundary: %v", err)
	}
	if err := validate(`{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}},` +
		`"secrets":{"token":{"file":"` + inside + `"}}}`); err != nil {
		t.Fatalf("rejected a secret file inside the checkout: %v", err)
	}
	for name, document := range map[string]string{
		"host ipc":       service(`,"ipc":"host"`),
		"host uts":       service(`,"uts":"host"`),
		"host cgroup":    service(`,"cgroup":"host"`),
		"host userns":    service(`,"userns_mode":"host"`),
		"devices":        service(`,"devices":["/dev/fuse:/dev/fuse"]`),
		"foreign volume": service(`,"volumes_from":["container:other"]`),
		"foreign secret": `{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}},` +
			`"secrets":{"token":{"file":"/etc/hosts"}}}`,
		"foreign config": `{"services":{"workspace":{"image":"node:owned","cap_drop":["ALL"]}},` +
			`"configs":{"token":{"file":"/etc/hosts"}}}`,
	} {
		if err := validate(document); err == nil {
			t.Fatalf("accepted a Compose project with %s", name)
		}
	}
}

func TestComposeNamedVolumesAreCheckedBeforeContainerPreparation(t *testing.T) {
	for _, test := range []struct {
		name       string
		definition string
		unmounted  bool
		wantError  string
	}{
		{name: "PostgreSQL default local", definition: `{"name":"owned_app-data"}`},
		{name: "explicit local", definition: `{"name":"owned_app-data","driver":"local"}`},
		{name: "empty default options", definition: `{"name":"owned_app-data","driver_opts":{},"external":false}`},
		{name: "empty local options", definition: `{"name":"owned_app-data","driver":"local","driver_opts":{},"external":false}`},
		{name: "rootfs bind", definition: `{"name":"owned_app-data","driver":"local","driver_opts":{"type":"none","o":"bind","device":"/"}}`, wantError: "driver options"},
		{name: "Parent state bind", definition: `{"name":"owned_app-data","driver":"local","driver_opts":{"type":"none","o":"bind","device":"/home/rootless/persist/connector"}}`, wantError: "driver options"},
		{name: "private Docker socket bind", definition: `{"name":"owned_app-data","driver":"local","driver_opts":{"type":"none","o":"bind","device":"/run/user/1000/docker.sock"}}`, wantError: "driver options"},
		{name: "default driver bind", definition: `{"name":"owned_app-data","driver_opts":{"type":"none","o":"bind","device":"/proc"}}`, wantError: "driver options"},
		{name: "empty option value", definition: `{"name":"owned_app-data","driver_opts":{"device":""}}`, wantError: "driver options"},
		{name: "custom driver", definition: `{"name":"owned_app-data","driver":"project-driver"}`, wantError: "local driver"},
		{name: "nonlocal driver", definition: `{"name":"owned_app-data","driver":"nfs"}`, wantError: "local driver"},
		{name: "external default volume", definition: `{"name":"existing-data","external":true}`, wantError: "external"},
		{name: "external local volume", definition: `{"name":"existing-data","driver":"local","external":true}`, wantError: "external"},
		{name: "unused external definition", definition: `{"name":"existing-data","external":true}`, unmounted: true, wantError: "external"},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			logPath := filepath.Join(directory, "commands")
			resolvedPath := filepath.Join(directory, "resolved.json")
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("FACTORY_COMPOSE_VOLUME_LOG", logPath)
			t.Setenv("FACTORY_COMPOSE_VOLUME_RESOLVED", resolvedPath)
			// config --format json keeps volume driver options and the boolean
			// external flag in top-level definitions, not service mount entries.
			postgres := map[string]any{"image": projectImage("b")}
			if !test.unmounted {
				postgres["volumes"] = []any{map[string]any{
					"type": "volume", "source": "app-data", "target": "/var/lib/postgresql/data",
					"volume": map[string]any{},
				}}
			}
			resolved := map[string]any{
				"name": "owned",
				"services": map[string]any{
					"workspace": map[string]any{
						"image": projectImage("a"), "cap_drop": []string{"ALL"},
						"depends_on": map[string]any{"postgres": map[string]any{"condition": "service_healthy"}},
						"volumes": []any{map[string]any{
							"type": "bind", "source": directory, "target": "/workspace/project",
						}},
					},
					"postgres": postgres,
				},
				"volumes": map[string]any{"app-data": json.RawMessage(test.definition)},
			}
			encoded, err := json.Marshal(resolved)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(resolvedPath, encoded, 0600); err != nil {
				t.Fatal(err)
			}
			for name, script := range map[string]string{
				"devcontainer": `#!/bin/sh
printf 'devcontainer %s\n' "$1" >> "$FACTORY_COMPOSE_VOLUME_LOG"
test "$1" = read-configuration || exit 99
printf '%s\n' '{"configuration":{"dockerComposeFile":"compose.yaml","service":"workspace"},"mergedConfiguration":{}}'
`,
				"docker": `#!/bin/sh
printf 'docker %s\n' "$*" >> "$FACTORY_COMPOSE_VOLUME_LOG"
case "$1 $2" in
  "compose --file")
    test "$6" = config && test "$7" = --format && test "$8" = json || exit 99
    cat "$FACTORY_COMPOSE_VOLUME_RESOLVED";;
  "image inspect") printf '["%s"]\n' "$5";;
  *) exit 99;;
esac
`,
			} {
				if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			err = prepareDevcontainerProject(context.Background(), Assignment{
				WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json",
			})
			if test.wantError == "" {
				if err != nil {
					t.Fatalf("ordinary local named volume was refused: %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), `Compose volume "app-data"`) || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("unsafe named volume was not refused at admission: %v", err)
			}
			commands, readErr := os.ReadFile(logPath)
			if readErr != nil {
				t.Fatal(readErr)
			}
			configCommand := "devcontainer read-configuration\ndocker compose --file " +
				filepath.Join(directory, ".devcontainer", "compose.yaml") + " --profile * config --format json\n"
			if test.wantError != "" {
				if string(commands) != configCommand {
					t.Fatalf("unsafe volume reached image acquisition or container execution: %s", commands)
				}
			} else if strings.Count(string(commands), configCommand) != 2 || strings.Count(string(commands), "docker image inspect ") != 2 || strings.Contains(string(commands), "devcontainer up") {
				t.Fatalf("local volume did not pass initial and merged preparation: %s", commands)
			}
		})
	}
}

func TestInitializeCommandIsRecognizedInEveryForm(t *testing.T) {
	for raw, want := range map[string]bool{
		``:                        false,
		`null`:                    false,
		`""`:                      false,
		`[]`:                      false,
		`{}`:                      false,
		` "npm run prepare" `:     true,
		`["npm","run","prepare"]`: true,
		`{"a":"echo a"}`:          true,
	} {
		if got := hasInitializeCommand(json.RawMessage(raw)); got != want {
			t.Errorf("initializeCommand %q: got %v want %v", raw, got, want)
		}
	}
}
