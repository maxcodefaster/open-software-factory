package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"path/filepath"
	"strings"
)

// gVisor's bridge interfaces cannot reach another bridge's local address. Build
// transport uses Docker's default bridge; lifecycle/Child transport must use the
// observed primary's own gateway. This is still the same Actor-private Tinyproxy,
// not a new proxy, a node address or additional native egress permission.
func nativeContainerProxy(ctx context.Context, containerID string) (string, error) {
	output, err := runtimeDockerCommand(ctx, "inspect", "--format", "{{json .NetworkSettings.Networks}}", containerID).Output()
	var endpoints map[string]struct {
		NetworkID string `json:"NetworkID"`
		Gateway   string `json:"Gateway"`
		IPAddress string `json:"IPAddress"`
	}
	if err != nil || len(output) > 1<<20 || json.Unmarshal(output, &endpoints) != nil || len(endpoints) != 1 {
		return "", errors.New("native primary requires one unambiguous private bridge gateway")
	}
	for name, endpoint := range endpoints {
		gateway, err := netip.ParseAddr(endpoint.Gateway)
		address, addressErr := netip.ParseAddr(endpoint.IPAddress)
		allowed := netip.MustParsePrefix("172.16.0.0/12")
		if err != nil || addressErr != nil || !allowed.Contains(gateway) || !allowed.Contains(address) || gateway == address || !regexpIdentity(endpoint.NetworkID) {
			return "", errors.New("native primary bridge address is outside the private proxy boundary")
		}
		output, err := runtimeDockerCommand(ctx, "network", "inspect", endpoint.NetworkID).Output()
		var networks []struct {
			ID       string `json:"Id"`
			Name     string `json:"Name"`
			Driver   string `json:"Driver"`
			Scope    string `json:"Scope"`
			Internal bool   `json:"Internal"`
			IPAM     struct {
				Config []struct {
					Subnet  string `json:"Subnet"`
					Gateway string `json:"Gateway"`
				} `json:"Config"`
			} `json:"IPAM"`
		}
		if err != nil || len(output) > 1<<20 || json.Unmarshal(output, &networks) != nil || len(networks) != 1 {
			return "", errors.New("native primary bridge identity is unavailable")
		}
		network := networks[0]
		if network.ID != endpoint.NetworkID || network.Name != name || network.Driver != "bridge" || network.Scope != "local" || network.Internal {
			return "", errors.New("native primary bridge identity changed or is not supported")
		}
		for _, config := range network.IPAM.Config {
			subnet, err := netip.ParsePrefix(config.Subnet)
			if err == nil && subnet.Bits() >= allowed.Bits() && allowed.Contains(subnet.Addr()) && config.Gateway == endpoint.Gateway && subnet.Contains(gateway) && subnet.Contains(address) {
				return "http://" + gateway.String() + ":8888", nil
			}
		}
	}
	return "", errors.New("native primary bridge gateway is unconfirmed")
}

// The pinned CLI owns hook order and completion markers. up ran with
// --skip-post-create, so no user lifecycle command has been dispatched yet. Run
// those commands once, on that exact inspected container, without another up or
// retry when execution or its reply fails.
func runNativeLifecycle(ctx context.Context, assignment Assignment, result devcontainerResult) error {
	proxy, err := nativeContainerProxy(ctx, result.ContainerID)
	if err != nil {
		return err
	}
	args := []string{"run-user-commands", "--container-id", result.ContainerID,
		"--workspace-folder", assignment.WorkspaceFolder,
		"--config", filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath),
		"--log-format", "text"}
	if assignment.EffectiveConfiguration != "" {
		args = append(args, "--override-config", assignment.EffectiveConfiguration)
	}
	if assignment.EnvironmentSecretsFile != "" {
		args = append(args, "--secrets-file", assignment.EnvironmentSecretsFile, "--oci-auth-hardening")
	}
	args = append(args, nativeDependencyRemoteEnvironment(assignment, proxy)...)
	command := exec.CommandContext(ctx, "devcontainer", args...)
	command.Env = devcontainerEnvironment(assignment)
	var stdout, diagnostic devcontainerFailureOutput
	command.Stdout, command.Stderr = &stdout, &diagnostic
	err = command.Run()
	if err == nil {
		outcome := ""
		for _, line := range strings.Split(stdout.String(), "\n") {
			var result struct {
				Outcome string `json:"outcome"`
			}
			if json.Unmarshal([]byte(line), &result) == nil && result.Outcome != "" {
				outcome = result.Outcome
			}
		}
		if outcome == "success" {
			return nil
		}
	}
	detail := devcontainerFailureDiagnostic(stdout.String(), diagnostic.String(), assignment)
	return fmt.Errorf("Dev Container lifecycle outcome is failed or unconfirmed; commands were not retried: %s", detail)
}
