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
