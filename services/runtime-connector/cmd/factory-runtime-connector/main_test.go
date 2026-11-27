package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestConnectorTokenIsRemovedFromChildEnvironments(t *testing.T) {
	t.Setenv("FACTORY_CONNECTOR_TOKEN", "owned-parent-capability")
	if token := takeConnectorToken(); token != "owned-parent-capability" {
		t.Fatalf("token was not returned: %q", token)
	}
	if _, present := os.LookupEnv("FACTORY_CONNECTOR_TOKEN"); present {
		t.Fatal("token remained in the process environment")
	}
	output, err := exec.Command("env").Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), "FACTORY_CONNECTOR_TOKEN") {
		t.Fatal("a child process inherited the token")
	}
}

func TestConnectorRejectsRetiredExecutionModesBeforeReadingAssignments(t *testing.T) {
	for _, mode := range []string{"parent", "reserve", "prepared-child", "prepared-control", "native-source-preserve", "native-source-preserve-reconcile", "native-bootstrap-mode", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			child := exec.Command(os.Args[0], "-test.run=^TestRetiredConnectorModeSubprocess$")
			child.Env = append(os.Environ(), "FACTORY_RETIRED_MODE_TEST="+mode)
			output, err := child.CombinedOutput()
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 1 || strings.TrimSpace(string(output)) != "mode must be a native entrypoint or child" {
				t.Fatalf("retired mode reached assignment, token or preparation handling: %v: %s", err, output)
			}
		})
	}
}

func TestRetiredConnectorModeSubprocess(t *testing.T) {
	mode := os.Getenv("FACTORY_RETIRED_MODE_TEST")
	if mode == "" {
		t.Skip("owned CLI subprocess")
	}
	os.Args = []string{os.Args[0], mode, "--assignment", "/owned-test-assignment-does-not-exist"}
	main()
}
