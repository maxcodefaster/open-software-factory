package connector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
)

// Only the trusted native transport crosses into the injected child. Its CA is
// copied, not mounted from infrastructure; no parent capability or control token
// reaches the Dev Container environment. Ordinary Factorybox injection is unchanged.
func nativeChildTransport(ctx context.Context, containerID string, generation uint64) ([]string, error) {
	uid := os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID")
	if uid == "" {
		return nil, nil
	}
	ca := os.Getenv("SSL_CERT_FILE")
	if ca == "" {
		return nil, errors.New("native child trust is unavailable")
	}
	proxy, err := nativeContainerProxy(ctx, containerID)
	if err != nil {
		return nil, err
	}
	destination := fmt.Sprintf("/tmp/factory-native-trust-%d.pem", generation)
	if err := exec.CommandContext(ctx, "docker", "cp", ca, containerID+":"+destination).Run(); err != nil {
		return nil, errors.New("native child trust copy failed")
	}
	if err := exec.CommandContext(ctx, "docker", "exec", "--user", "0:0", containerID, "chmod", "0444", destination).Run(); err != nil {
		return nil, errors.New("native child trust permissions failed")
	}
	var flags []string
	for _, pair := range []string{
		"FACTORY_SUBSTRATE_ACTOR_UID=" + uid,
		"SSL_CERT_FILE=" + destination, "GIT_SSL_CAINFO=" + destination, "NODE_EXTRA_CA_CERTS=" + destination, "FACTORY_CONNECTOR_CA_FILE=" + destination,
		"HTTP_PROXY=" + proxy, "HTTPS_PROXY=" + proxy, "http_proxy=" + proxy, "https_proxy=" + proxy, "NO_PROXY=localhost,127.0.0.1", "no_proxy=localhost,127.0.0.1",
	} {
		flags = append(flags, "--env", pair)
	}
	return flags, nil
}

// The pinned gVisor virtual kernel has no cgroup-namespace feature. In that
// concrete profile, Docker's inner "host" means the Actor-private virtual
// cgroups, not the physical node. Only native-parent can set this unexported
// assignment fact, after verifying the private RootlessKit UID/GID mappings.
// Parent has also authenticated the Actor-bound capability before inspection.
// A caller-supplied environment variable alone never enables this exception.
func nativeActorCgroups(assignment Assignment, projectedUID string, namespaceError error) bool {
	return assignment.nativeActorUID != "" && assignment.nativeActorUID == projectedUID && os.IsNotExist(namespaceError)
}
