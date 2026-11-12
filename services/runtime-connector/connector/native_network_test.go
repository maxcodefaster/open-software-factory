package connector

import (
	"context"
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
    printf '{"outcome":"success","containerId":"%s","composeProjectName":"owned","remoteUser":"node","remoteWorkspaceFolder":"/workspace/project"}\n' "$NATIVE_NETWORK_PRIMARY" ;;
  run-user-commands)
    case "$NATIVE_NETWORK_SCENARIO" in
      lost-reply) exit 1 ;;
      incomplete) printf '{"outcome":"success"}\n{"outcome":"unknown"}\n' ;;
      failed) printf '{"outcome":"error","description":"postCreateCommand failed; PRIVATE_TOKEN=private-value"}\n'; exit 1 ;;
      *) printf '{"outcome":"success"}\n' ;;
    esac ;;
  *) exit 9 ;;
esac
`,
	}
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

func TestNativeProxyRequiresActualUnambiguousPrivateBridgeIdentity(t *testing.T) {
	for _, scenario := range []string{"compose", "default", "no-network", "multiple", "public-gateway", "outside-allowlist", "same-address", "bad-network-id", "changed-network-id", "changed-network-name", "overlay-driver", "global-scope", "internal", "different-gateway", "different-subnet", "unbounded-subnet", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			directory := nativeNetworkFixture(t)
			endpoints, _ := os.ReadFile(filepath.Join(directory, "endpoints"))
			network, _ := os.ReadFile(filepath.Join(directory, "network"))
			switch scenario {
			case "default":
				endpoints = []byte(strings.ReplaceAll(string(endpoints), "172.18.", "172.17."))
				network = []byte(strings.ReplaceAll(string(network), "172.18.", "172.17."))
			case "no-network":
				endpoints = []byte(`{}`)
			case "multiple":
				endpoints = []byte(`{"one":{},"two":{}}`)
			case "public-gateway":
				endpoints = []byte(strings.ReplaceAll(string(endpoints), "172.18.0.1", "8.8.8.8"))
			case "outside-allowlist":
				endpoints = []byte(strings.ReplaceAll(string(endpoints), "172.18.", "192.168."))
			case "same-address":
				endpoints = []byte(strings.ReplaceAll(string(endpoints), "172.18.0.3", "172.18.0.1"))
			case "bad-network-id":
				endpoints = []byte(strings.ReplaceAll(string(endpoints), strings.Repeat("a", 64), "foreign"))
			case "changed-network-id":
				network = []byte(strings.ReplaceAll(string(network), strings.Repeat("a", 64), strings.Repeat("c", 64)))
			case "changed-network-name":
				network = []byte(strings.ReplaceAll(string(network), "owned_default", "foreign_default"))
			case "overlay-driver":
				network = []byte(strings.ReplaceAll(string(network), `"bridge"`, `"overlay"`))
			case "global-scope":
				network = []byte(strings.ReplaceAll(string(network), `"local"`, `"global"`))
			case "internal":
				network = []byte(strings.ReplaceAll(string(network), `"Internal":false`, `"Internal":true`))
			case "different-gateway":
				network = []byte(strings.ReplaceAll(string(network), "172.18.0.1", "172.18.0.2"))
			case "different-subnet":
				network = []byte(strings.ReplaceAll(string(network), "172.18.0.0/16", "172.19.0.0/16"))
			case "unbounded-subnet":
				network = []byte(strings.ReplaceAll(string(network), "172.18.0.0/16", "0.0.0.0/0"))
			case "malformed":
				network = []byte(`not-json`)
			}
			for name, data := range map[string][]byte{"endpoints": endpoints, "network": network} {
				if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			proxy, err := nativeContainerProxy(context.Background(), "exact-primary")
			if scenario == "compose" || scenario == "default" {
				want := "http://172.18.0.1:8888"
				if scenario == "default" {
					want = "http://172.17.0.1:8888"
				}
				if err != nil || proxy != want {
					t.Fatalf("wrong private proxy: %q, %v", proxy, err)
				}
			} else if err == nil {
				t.Fatal("unconfirmed proxy boundary accepted")
			}
			trace, _ := os.ReadFile(filepath.Join(directory, "docker.log"))
			for _, forbidden := range []string{" exec ", " cp ", "create", "connect", "rm ", "update"} {
				if strings.Contains(" "+string(trace), forbidden) {
					t.Fatal("proxy observation changed runtime resources")
				}
			}
		})
	}
}

func TestNativeStartupInspectsPrimaryBeforeOneExactContainerLifecycleDispatch(t *testing.T) {
	for _, scenario := range []string{"success", "lost-reply", "incomplete", "failed", "foreign-primary", "privileged-primary", "missing-network"} {
		t.Run(scenario, func(t *testing.T) {
			directory := nativeNetworkFixture(t)
			t.Setenv("NATIVE_NETWORK_SCENARIO", scenario)
			assignment := Assignment{RuntimeAttemptID: "owned-attempt", Generation: 1, ComposeProjectName: "owned", WorkspaceFolder: directory, DevcontainerPath: ".devcontainer/devcontainer.json", RemoteWorkspaceFolder: "/workspace/project", nativeActorUID: "owned-actor", EffectiveConfiguration: "/private/generated/devcontainer.json", EnvironmentSecretsFile: "/private/grants", RuntimeEnvironment: map[string]string{"PRIVATE_TOKEN": "private-value"}}
			if scenario == "foreign-primary" || scenario == "privileged-primary" {
				data, _ := os.ReadFile(filepath.Join(directory, "primary"))
				if scenario == "foreign-primary" {
					data = []byte(strings.ReplaceAll(string(data), "owned-attempt", "foreign-attempt"))
				} else {
					data = []byte(strings.ReplaceAll(string(data), `"CapDrop":["ALL"]`, `"CapDrop":["ALL"],"Privileged":true`))
				}
				if err := os.WriteFile(filepath.Join(directory, "primary"), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "missing-network" {
				if err := os.WriteFile(filepath.Join(directory, "endpoints"), []byte(`{}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			_, err := startDevcontainer(context.Background(), assignment)
			if (err == nil) != (scenario == "success") {
				t.Fatalf("unexpected startup outcome: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "private-value") {
				t.Fatal("lifecycle failure leaked credentials")
			}
			trace, _ := os.ReadFile(filepath.Join(directory, "cli.log"))
			lines := strings.Split(strings.TrimSpace(string(trace)), "\n")
			blocked := scenario == "foreign-primary" || scenario == "privileged-primary" || scenario == "missing-network"
			if len(lines) != 2 && !blocked || len(lines) != 1 && blocked {
				t.Fatalf("CLI dispatch repeated or crossed boundary: %s", trace)
			}
			if !strings.Contains(lines[0], "--skip-post-create") || strings.Contains(lines[0], "--remote-env") {
				t.Fatal("user hooks ran before bridge observation")
			}
			if !blocked {
				for _, required := range []string{"run-user-commands --container-id " + strings.Repeat("b", 64), "--override-config /private/generated/devcontainer.json", "--secrets-file /private/grants --oci-auth-hardening", "--remote-env HTTPS_PROXY=http://172.18.0.1:8888", "--remote-env NODE_EXTRA_CA_CERTS=" + nativeDependencyCA} {
					if !strings.Contains(lines[1], required) {
						t.Fatalf("missing lifecycle boundary: %s", required)
					}
				}
			}
		})
	}
}

// Used only inside the existing owned Actor, against its already running primary.
// It executes no hooks, starts no container and creates no competing runtime.
func TestNativeComposeGatewayLive(t *testing.T) {
	id := os.Getenv("FACTORY_NATIVE_NETWORK_LIVE_CONTAINER")
	if id == "" {
		t.Skip("requires an explicitly owned live native primary")
	}
	if !regexpIdentity(id) {
		t.Fatal("invalid primary ID")
	}
	ctx := context.Background()
	proxy, err := nativeContainerProxy(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	// Use Node's strict TLS client through CONNECT and the supplemental public CA.
	script := `const http=require('node:http'),tls=require('node:tls');const p=new URL(process.argv[1]);const r=http.request({hostname:p.hostname,port:p.port,method:'CONNECT',path:'registry.npmjs.org:443',timeout:10000});r.on('connect',(res,s)=>{if(res.statusCode!==200)throw Error('tunnel denied');const socket=tls.connect({socket:s,servername:'registry.npmjs.org'});socket.setTimeout(10000,()=>socket.destroy(Error('TLS timeout')));socket.on('secureConnect',()=>socket.write('GET /npm/latest HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n'));let head='';socket.on('data',d=>{head+=d.toString();if(head.includes('\r\n')){if(!head.startsWith('HTTP/1.1 200 '))throw Error('registry rejected request');console.log('Strict TLS npm read passed through observed Compose gateway');socket.destroy()}});socket.on('error',e=>{throw e})});r.on('timeout',()=>r.destroy(Error('proxy timeout')));r.on('error',e=>{throw e});r.end()`
	output, err := runtimeDockerCommand(ctx, "exec", "--user", "node", "--env", "NODE_EXTRA_CA_CERTS="+nativeDependencyCA, id, "node", "-e", script, proxy).CombinedOutput()
	if err != nil || !strings.Contains(string(output), "Strict TLS npm read passed") {
		t.Fatalf("actual Compose transport: %v: %s", err, output)
	}
	encoded, _ := json.Marshal(proxy)
	t.Logf("Actual private bridge selected: %s", encoded)
}
