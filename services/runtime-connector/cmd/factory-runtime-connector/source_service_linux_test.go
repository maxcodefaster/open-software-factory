package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
	"golang.org/x/sys/unix"
)

// Exercise the actual CLI Source service with the same pre-exec development
// identity and inherited descriptors used by the native Source host.
func TestNativeSourceServiceRunsAsDevelopmentUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	directory, err := os.MkdirTemp("", "factory-source-identity-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(directory, "private")
	root := filepath.Join(directory, "project")
	spool := filepath.Join(directory, "spool")
	for _, path := range []string{private, root, spool} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if path != private {
			if err := os.Chown(path, 1000, 1000); err != nil {
				t.Fatal(err)
			}
		}
	}
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(directory, "connector.test")
	if err := os.WriteFile(executable, binary, 0555); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(private, "source.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	defer listener.Close()
	fd, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	defer fd.Close()
	source, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	cache, err := os.Open(spool)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	access := workspacefiles.Access{
		WorkspaceID: "owned-source", ServiceID: "source-owned-source", Epoch: 1,
		OwnerEpoch: 1, WriterEpoch: 1, Token: strings.Repeat("a", 64),
	}
	input, err := json.Marshal(access)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestNativeSourceServiceCLIChild$")
	command.Stdin = bytes.NewReader(input)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/proc/self/fd/5", "FACTORY_SOURCE_SERVICE_CLI_TEST=1"}
	command.ExtraFiles = []*os.File{fd, source, cache}
	command.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}},
	}
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	defer func() {
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("owned Source service shutdown failed: %v: %s", err, output.String())
			}
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			<-done
			t.Error("owned Source service did not join its normal shutdown")
		}
	}()
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	request := func(operation string, value any) (*http.Response, error) {
		body, _ := json.Marshal(value)
		request, err := http.NewRequest("POST", "http://source/v1/workspaces/owned-source/"+operation, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+access.Token)
		request.Header.Set("X-Factory-Source-Service", access.ServiceID)
		request.Header.Set("X-Factory-Source-Epoch", "1")
		request.Header.Set("X-Factory-Writer-Epoch", "1")
		return client.Do(request)
	}
	until := time.Now().Add(10 * time.Second)
	for {
		response, err := request("stat", map[string]string{"path": ""})
		if err == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(until) {
			t.Fatal("actual Source CLI did not become ready through its private inherited listener")
		}
		time.Sleep(20 * time.Millisecond)
	}
	pid := command.Process.Pid
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	credentials := sourceStatusCredentials(status)
	if err != nil || credentials["Uid:"] != "1000 1000 1000 1000" ||
		credentials["Gid:"] != "1000 1000 1000 1000" ||
		credentials["CapEff:"] != "0000000000000000" ||
		credentials["Groups:"] != "" {
		t.Fatalf("actual Source process retained privileged credentials: %v: %v", credentials, err)
	}
	threads, err := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid))
	if err != nil {
		t.Fatal(err)
	}
	for _, thread := range threads {
		state, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%s/status", pid, thread.Name()))
		if os.IsNotExist(err) {
			continue
		}
		credentials := sourceStatusCredentials(state)
		if err != nil || credentials["Uid:"] != "1000 1000 1000 1000" ||
			credentials["Gid:"] != "1000 1000 1000 1000" ||
			credentials["CapEff:"] != "0000000000000000" ||
			credentials["Groups:"] != "" {
			t.Fatalf("actual Source thread retained initializer authority: %s: %v: %v", thread.Name(), credentials, err)
		}
	}
	response, err := request("write", map[string]any{"path": "owned.txt", "content": []byte("development source\n")})
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("actual Source CLI could not save development Source: HTTP %d", response.StatusCode)
	}
	var stat unix.Stat_t
	if unix.Stat(filepath.Join(root, "owned.txt"), &stat) != nil || stat.Uid != 1000 || stat.Gid != 1000 {
		t.Fatal("actual Source service created files with another identity")
	}
	content, err := os.ReadFile(filepath.Join(root, "owned.txt"))
	if err != nil || string(content) != "development source\n" {
		t.Fatal("actual Source service did not save the observed file bytes")
	}
}

func sourceStatusCredentials(status []byte) map[string]string {
	credentials := make(map[string]string)
	for _, line := range strings.Split(string(status), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "Uid:", "Gid:", "CapEff:", "Groups:":
			credentials[fields[0]] = strings.Join(fields[1:], " ")
		}
	}
	return credentials
}

func TestNativeSourceServiceCLIChild(t *testing.T) {
	if os.Getenv("FACTORY_SOURCE_SERVICE_CLI_TEST") != "1" {
		t.Skip("owned Source CLI subprocess")
	}
	if unix.Setuid(0) == nil || unix.Setgid(0) == nil {
		t.Fatal("Source regained initializer identity")
	}
	os.Args = []string{os.Args[0], "source-service"}
	main()
}
