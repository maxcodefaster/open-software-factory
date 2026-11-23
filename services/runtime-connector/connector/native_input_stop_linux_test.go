package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestNativeInputStopPrivateBindRestrictions(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_INPUT_STOP_MOUNT_PROOF") != "1" {
		t.Skip("explicit owned read/write, non-executable metadata mount proof only")
	}
	if _, err := os.Stat("/run/ate/identity/uid"); !os.IsNotExist(err) {
		t.Fatal("never use a retained native Actor for the private mount fixture")
	}
	var before unix.Statfs_t
	if err := unix.Statfs(inputStopGit, &before); err != nil {
		t.Fatal(err)
	}
	const restrictions = unix.ST_NOSUID | unix.ST_NODEV | unix.ST_NOEXEC
	if before.Flags&restrictions != restrictions || before.Flags&unix.ST_RDONLY != 0 {
		t.Fatal("fixture requires writable metadata with inherited nosuid,nodev,noexec")
	}
	root := t.TempDir()
	target := filepath.Join(root, "metadata")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := unix.Unmount(target, unix.MNT_DETACH); err != nil && err != unix.EINVAL {
			t.Error(err)
		}
	})
	if err := mountInputStopPath(root, inputStopGit, "/metadata", false, false); err != nil {
		t.Fatal(err)
	}
	var after unix.Statfs_t
	if err := unix.Statfs(target, &after); err != nil {
		t.Fatal(err)
	}
	if after.Flags&restrictions != restrictions || after.Flags&unix.ST_RDONLY != 0 {
		t.Fatal("private bind weakened original restrictions or made metadata read-only")
	}
}

func TestNativeInputStopDirectoriesIgnorePrivateUmask(t *testing.T) {
	root := t.TempDir()
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	if err := createInputStopDirectories(root); err != nil {
		t.Fatal(err)
	}
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path != root && (!info.IsDir() || info.Mode().Perm() != 0755) {
			t.Errorf("private worker path is not a traversable directory: %s %v", path, info.Mode())
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if retained := syscall.Umask(0077); retained != 0077 {
		t.Fatalf("private worker changed its inherited umask: %04o", retained)
	}
}

func TestNativeInputStopLocationOwnershipPreservesFixedRoots(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("private Stop root ownership runs in the owned Linux lane")
	}
	root := t.TempDir()
	if err := createInputStopDirectories(root); err != nil {
		t.Fatal(err)
	}
	if err := ownInputStopLocations(root); err != nil {
		t.Fatal(err)
	}
	for path, uid := range map[string]uint32{
		"": 1000, "/home": 1000, "/home/rootless": 1000, "/usr": 1000,
		"/opt": 1000, "/workspace": 1000, "/workspace/project": 1000,
		"/lib": 0, "/usr/lib": 0, "/usr/bin": 0, "/opt/factory": 0, inputStopGit: 0,
	} {
		info, err := os.Stat(filepath.Join(root, path))
		if err != nil {
			t.Fatal(err)
		}
		metadata, ok := info.Sys().(*syscall.Stat_t)
		if !ok || metadata.Uid != uid || metadata.Gid != uid {
			t.Errorf("private location ownership changed a fixed root or missed %s", path)
		}
	}
}

func TestNativeInputStopPackagedWorker(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_INPUT_STOP_PACKAGED_PROOF") != "1" {
		t.Skip("explicit packaged-SDK process proof only")
	}
	var input nativeInputStop
	if err := readInputStopJSON(os.Stdin, &input); err != nil {
		t.Fatal(err)
	}
	// Native bootstrap retains a private umask. The fixed worker must still
	// construct traversable tool/metadata ancestors before dropping to UID 1000.
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	result, err := executeNativeInputStop(t.Context(), input, "/usr/local/bin/factory-runtime-connector")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	t.Log("FACTORY_INPUT_STOP_RESULT " + string(encoded))
}

func TestNativeInputStopPrivateProcessBoundary(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_INPUT_STOP_NAMESPACE_PROOF") != "1" {
		t.Skip("explicit owned Linux namespace proof only")
	}
	if os.Geteuid() != 0 {
		t.Fatal("proof requires its owned container root")
	}
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	worker := inputStopServer + "/input-stop.mjs"
	original, err := os.ReadFile(worker)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(worker, original, 0644); err != nil {
			t.Error(err)
		}
	})
	if err := os.MkdirAll(inputStopGit, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(inputStopGit, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(filepath.Dir(inputStopGit), "unpublished.txt")
	if err := os.WriteFile(outside, []byte("private Project source"), 0644); err != nil {
		t.Fatal(err)
	}
	network, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FACTORY_SUBSTRATE_BOOTSTRAP", "owned Factory capability must not reach worker")
	t.Setenv("FACTORY_MODEL_TOKEN", "owned provider capability must not reach worker")
	t.Setenv("OPENCODE_CONFIG_CONTENT", "owned configuration must not reach worker")
	for _, scenario := range []string{"isolation", "detached-child", "cancel", "different-result", "oversized-result"} {
		t.Run(scenario, func(t *testing.T) {
			for _, name := range []string{"pulse", "child-started", "boundary.json"} {
				if err := os.Remove(filepath.Join(inputStopGit, name)); err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
			}
			script := `
import { readFileSync, readlinkSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
const input = await Bun.stdin.json();
const git = "/home/rootless/persist/project/.git";
if (process.getuid() !== 1000 || process.pid !== 1) throw Error("wrong worker identity");
if (Object.keys(process.env).some(key => /^(FACTORY_|OPENCODE_|HTTP_PROXY|HTTPS_PROXY)/.test(key))) throw Error("capability inherited");
if (existsSync("/home/rootless/persist/project/unpublished.txt") || existsSync("/home/rootless/persist/connector") || existsSync("/run/user/1000/docker.sock") || existsSync("/usr/bin/git") || existsSync("/usr/local/bin/docker")) throw Error("private runtime/Source exposed");
if (readdirSync("/workspace/project").length) throw Error("Project location is not empty");
if (Object.keys(networkInterfaces()).some(name => name !== "lo")) throw Error("external network interface exposed");
let writableTools = false;
try { writeFileSync("/opt/factory/opencode/server/forbidden-write", "no"); writableTools = true; } catch {}
if (writableTools) throw Error("worker can rewrite its tools");
const boundary = { network: readlinkSync("/proc/self/ns/net"), env: Object.keys(process.env).sort() };
writeFileSync(git + "/boundary.json", JSON.stringify(boundary));
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response("private-loopback");}});
if (await (await fetch(server.url)).text() !== "private-loopback") throw Error("private loopback unavailable");
server.stop(true);
`
			if scenario == "detached-child" || scenario == "cancel" {
				script += `
const child = spawn(process.execPath, ["--no-env-file","-e", 'const fs=require("node:fs");fs.writeFileSync("` + inputStopGit + `/child-started","yes");setInterval(()=>fs.appendFileSync("` + inputStopGit + `/pulse","x"),10);'], {detached:true,stdio:"ignore",env:{PATH:"/usr/bin:/bin"}});
child.unref();
while (!existsSync(git + "/child-started") || !existsSync(git + "/pulse")) await Bun.sleep(10);
`
			}
			switch scenario {
			case "cancel":
				script += "setInterval(()=>{},1000);\nawait new Promise(()=>{});\n"
			case "different-result":
				script += `console.log(JSON.stringify({...input,stopID:input.attemptID,confirmed:true,engineExited:true}));` + "\n"
			case "oversized-result":
				script += `console.log("x".repeat(8193));` + "\n"
			default:
				script += `console.log(JSON.stringify({...input,confirmed:true,engineExited:true}));` + "\n"
			}
			if err := os.WriteFile(worker, []byte(script), 0644); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			type completion struct {
				result nativeInputStopResult
				err    error
			}
			done := make(chan completion, 1)
			joined := false
			go func() {
				result, err := executeNativeInputStop(ctx, ownedInputStop(), "/usr/local/bin/factory-runtime-connector")
				done <- completion{result, err}
			}()
			t.Cleanup(func() {
				cancel()
				if !joined {
					select {
					case <-done:
					case <-time.After(10 * time.Second):
						t.Error("owned input Stop did not join during cleanup")
					}
				}
			})
			if scenario == "cancel" {
				timer := time.NewTimer(10 * time.Second)
				defer timer.Stop()
				for {
					if _, err := os.Stat(filepath.Join(inputStopGit, "pulse")); err == nil {
						break
					}
					select {
					case result := <-done:
						joined = true
						t.Fatalf("worker ended before its cancellation check: %v", result.err)
					case <-timer.C:
						t.Fatal("owned worker did not reach cancellation checkpoint")
					case <-time.After(10 * time.Millisecond):
					}
				}
				cancel()
			}
			var completed completion
			select {
			case completed = <-done:
				joined = true
			case <-time.After(15 * time.Second):
				t.Fatal("owned namespace init was not joined")
			}
			success := scenario == "isolation" || scenario == "detached-child"
			if success {
				if completed.err != nil || !completed.result.ProcessTreeExited || completed.result.nativeInputStop != ownedInputStop() {
					t.Fatalf("private worker did not confirm exact result: %+v %v", completed.result, completed.err)
				}
			} else if completed.err == nil || completed.result.ProcessTreeExited {
				t.Fatal("failed/cancelled worker supplied a successful Stop result")
			}
			if data, err := os.ReadFile(filepath.Join(inputStopGit, "boundary.json")); err == nil {
				var boundary struct {
					Network string `json:"network"`
				}
				if json.Unmarshal(data, &boundary) != nil || boundary.Network == network {
					t.Fatal("worker retained its Parent network namespace")
				}
			} else {
				t.Fatal("worker did not establish its restricted root", err)
			}
			if scenario == "detached-child" || scenario == "cancel" {
				before, err := os.ReadFile(filepath.Join(inputStopGit, "pulse"))
				if err != nil {
					t.Fatal(err)
				}
				time.Sleep(300 * time.Millisecond)
				after, err := os.ReadFile(filepath.Join(inputStopGit, "pulse"))
				if err != nil || string(before) != string(after) {
					t.Fatal("detached worker survived namespace init exit", err)
				}
			}
			source, err := os.ReadFile(outside)
			if err != nil || strings.TrimSpace(string(source)) != "private Project source" {
				t.Fatal("worker changed unpublished Source", err)
			}
		})
	}
}
