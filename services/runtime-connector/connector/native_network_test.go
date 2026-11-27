package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeNetworkFixture(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	files := map[string]string{
		"endpoints": `{"owned_default":{"NetworkID":"` + strings.Repeat("a", 64) + `","Gateway":"172.18.0.1","IPAddress":"172.18.0.3"}}`,
		"network":   `[{"Id":"` + strings.Repeat("a", 64) + `","Name":"owned_default","Driver":"bridge","Scope":"local","Internal":false,"IPAM":{"Config":[{"Subnet":"172.18.0.0/16","Gateway":"172.18.0.1"}]}}]`,
		"primary":   `[{"Id":"` + strings.Repeat("b", 64) + `","State":{"Running":true},"Config":{"Labels":{"factory.dev/runtime-attempt":"owned-attempt","factory.dev/runtime-generation":"1","com.docker.compose.project":"owned"}},"HostConfig":{"CapDrop":["ALL"]}}]`,
		"docker": `#!/bin/sh
printf '%s\n' "$*" >> "$NATIVE_NETWORK_FIXTURE/docker.log"
case "$1 $2" in
  'inspect --format') cat "$NATIVE_NETWORK_FIXTURE/endpoints" ;;
  'network inspect') cat "$NATIVE_NETWORK_FIXTURE/network" ;;
  'inspect '*) cat "$NATIVE_NETWORK_FIXTURE/primary" ;;
  'ps '*) ;;
  'cp '*|'exec '*) ;;
  *) exit 9 ;;
esac
`,
		"devcontainer": `#!/bin/sh
printf '%s\n' "$*" >> "$NATIVE_NETWORK_FIXTURE/cli.log"
case "$1" in
  up)
    case " $* " in *' --skip-post-create '*) ;; *) exit 8 ;; esac
    if [ -n "$NATIVE_NETWORK_UP_RESULT" ]; then
      printf '%s\n' "$NATIVE_NETWORK_UP_RESULT"
    else
      printf '{"outcome":"success","containerId":"%s","composeProjectName":"owned","remoteUser":"node","remoteWorkspaceFolder":"%s"}\n' "$NATIVE_NETWORK_PRIMARY" "${NATIVE_NETWORK_REMOTE_WORKSPACE:-/workspace/project}"
    fi ;;
  run-user-commands)
    case "$NATIVE_NETWORK_SCENARIO" in
      lost-reply) exit 1 ;;
      incomplete) printf '{"outcome":"success"}\n{"outcome":"unknown"}\n' ;;
      failed) printf '{"outcome":"error","description":"postCreateCommand failed; PRIVATE_TOKEN=private-value"}\n'; exit 1 ;;
      *) printf '{"outcome":"success","result":"done"}\n' ;;
    esac ;;
  *) exit 9 ;;
esac
`,
	}
	var primary []map[string]any
	if err := json.Unmarshal([]byte(files["primary"]), &primary); err != nil {
		t.Fatal(err)
	}
	primary[0]["Mounts"] = []map[string]any{{
		"Type": "bind", "Source": directory, "Destination": "/workspace/project", "RW": true,
	}}
	content, err := json.Marshal(primary)
	if err != nil {
		t.Fatal(err)
	}
	files["primary"] = string(content)
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(data), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NATIVE_NETWORK_FIXTURE", directory)
	t.Setenv("NATIVE_NETWORK_PRIMARY", strings.Repeat("b", 64))
	return directory
}
