package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunArgumentsRefuseVolumesSecurityOptionsAndHostNamespaces(t *testing.T) {
	workspace := t.TempDir()
	inside := filepath.Join(workspace, "data")
	if err := os.Mkdir(inside, 0755); err != nil {
		t.Fatal(err)
	}
	for _, arguments := range [][]string{
		{"-v", "/etc:/host-etc"}, {"-v=/etc:/host-etc"}, {"-v/etc:/host-etc"}, {"--volume", "/etc:/host-etc:ro"}, {"--volume=/var/run/docker.sock:/docker.sock"},
		{"-v", "./../outside:/x"}, {"-v", "/var/run/docker.sock"},
		{"--mount", "type=bind,source=/etc,target=/host-etc"}, {"--mount=type=bind,src=/,dst=/host"},
		{"--mount", "type=bind,source=" + inside + ",target=/var/run/docker.sock"},
		{"--security-opt", "seccomp=unconfined"}, {"--security-opt=apparmor=unconfined"},
		{"--userns", "host"}, {"--userns=host"}, {"--cap-add", "SYS_ADMIN"}, {"--device=/dev/kvm"},
		{"--privileged"}, {"--pid=host"}, {"--ipc=host"}, {"--network=host"}, {"--net=host"}, {"--uts=host"},
		{"--network", "container:other"}, {"--cgroupns=host"}, {"--volumes-from=other"},
		{"--env-file=/factory/assignment/env"}, {"--runtime=runc-unsafe"}, {"--cgroup-parent=/system"},
	} {
		if err := validateRunArguments(workspace, arguments); err == nil {
			t.Fatalf("accepted forbidden run arguments: %v", arguments)
		}
	}
	for _, arguments := range [][]string{
		{"-v", inside + ":/data"}, {"--volume=" + inside + ":/data:ro"}, {"-v", "cache:/cache"}, {"-v", "/cache"},
		{"--mount", "type=volume,source=cache,target=/cache"}, {"--mount", "type=bind,source=" + inside + ",target=/data"},
		{"--cap-drop", "NET_RAW"}, {"--network", "bridge"}, {"--init"}, {"--shm-size=1g"},
	} {
		if err := validateRunArguments(workspace, arguments); err != nil {
			t.Fatalf("rejected safe run arguments %v: %v", arguments, err)
		}
	}
}

func TestResolvedContainerRefusesDisabledConfinement(t *testing.T) {
	assignment := validAssignment()
	assignment.WorkspaceFolder = t.TempDir()
	for _, option := range []string{"seccomp=unconfined", "apparmor=unconfined", "label=disable", "label:disable", "systempaths=unconfined", "SECCOMP:UNCONFINED"} {
		container := inspectedContainer{}
		container.HostConfig.CapDrop = []string{"ALL"}
		container.HostConfig.SecurityOpt = []string{option}
		if err := validateContainerBoundary(container, assignment); err == nil {
			t.Fatalf("accepted resolved security option %q", option)
		}
	}
	container := inspectedContainer{}
	container.HostConfig.CapDrop = []string{"ALL"}
	container.HostConfig.SecurityOpt = []string{"no-new-privileges", "apparmor=docker-default"}
	if err := validateContainerBoundary(container, assignment); err != nil {
		t.Fatal(err)
	}
}

// A fake Dev Containers CLI answers read-configuration so the pre-start
// validation, which runs before any lifecycle hook, can be exercised directly.
func TestDevcontainerConfigurationIsRefusedBeforeStart(t *testing.T) {
	workspace := t.TempDir()
	commands := t.TempDir()
	response := filepath.Join(commands, "response.json")
	script := "#!/bin/sh\ncat \"" + response + "\"\n"
	if err := os.WriteFile(filepath.Join(commands, "devcontainer"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", commands+string(os.PathListSeparator)+os.Getenv("PATH"))
	assignment := validAssignment()
	assignment.WorkspaceFolder = workspace
	read := func(configuration, merged map[string]any) error {
		t.Helper()
		var content bytes.Buffer
		if err := json.NewEncoder(&content).Encode(map[string]any{"configuration": configuration, "mergedConfiguration": merged}); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(response, content.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := validateDevcontainerConfiguration(context.Background(), assignment, true)
		return err
	}
	if err := read(map[string]any{"image": "registry.example/app@sha256:" + strings.Repeat("a", 64), "runArgs": []string{"--cap-drop=NET_RAW"}}, map[string]any{}); err != nil {
		t.Fatalf("safe configuration was rejected: %v", err)
	}
	for name, test := range map[string]struct{ configuration, merged map[string]any }{
		"privileged":          {map[string]any{"privileged": true}, map[string]any{}},
		"merged privileged":   {map[string]any{}, map[string]any{"privileged": true}},
		"cap add":             {map[string]any{"capAdd": []string{"SYS_PTRACE"}}, map[string]any{}},
		"feature cap add":     {map[string]any{}, map[string]any{"capAdd": []string{"SYS_ADMIN"}}},
		"seccomp unconfined":  {map[string]any{"securityOpt": []string{"seccomp=unconfined"}}, map[string]any{}},
		"feature apparmor":    {map[string]any{}, map[string]any{"securityOpt": []string{"apparmor=unconfined"}}},
		"host volume":         {map[string]any{"runArgs": []string{"-v", "/etc:/host-etc"}}, map[string]any{}},
		"merged host mount":   {map[string]any{}, map[string]any{"mounts": []string{"type=bind,source=/etc,target=/host-etc"}}},
		"docker socket mount": {map[string]any{"mounts": []string{"source=/var/run/docker.sock,target=/docker.sock,type=bind"}}, map[string]any{}},
	} {
		if err := read(test.configuration, test.merged); err == nil {
			t.Fatalf("%s reached devcontainer up", name)
		}
	}
}

func TestReportChildExitRecordsStatus(t *testing.T) {
	assignment := validAssignment()
	var output bytes.Buffer
	reportChildExit(&output, assignment, nil)
	reportChildExit(&output, assignment, os.ErrClosed)
	text := output.String()
	if !strings.Contains(text, assignment.RuntimeAttemptID) || !strings.Contains(text, "exited\n") || !strings.Contains(text, "exited: "+os.ErrClosed.Error()) {
		t.Fatalf("child exit was not reported: %q", text)
	}
}
