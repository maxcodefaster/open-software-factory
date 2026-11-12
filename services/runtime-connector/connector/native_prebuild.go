package connector

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"os"
	"strings"
)

type nativePrebuildTransportKey struct{}

// Set only from the Parent's unexported, verified native assignment. No request
// or Project environment can enable transport or supply a different proxy.
func nativePrebuildContext(ctx context.Context, assignment Assignment) (context.Context, error) {
	if assignment.nativeActorUID == "" {
		return ctx, nil
	}
	if assignment.nativeActorUID != os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID") || os.Getenv("XDG_RUNTIME_DIR") != "/run/user/1000" || os.Getenv("DOCKER_HOST") != "unix:///run/user/1000/docker.sock" ||
		os.Getenv("HTTP_PROXY") != "http://127.0.0.1:8888" || os.Getenv("HTTPS_PROXY") != "http://127.0.0.1:8888" {
		return nil, errors.New("native prebuild private transport authority is unavailable")
	}
	return context.WithValue(ctx, nativePrebuildTransportKey{}, true), nil
}

// Private, in-memory facts only. They are never decoded from Source, included
// in the portable recipe hash, or serialized into its persisted intent.
type nativePrebuildBase struct {
	assignment Assignment
	reference  string
	base       string
	transport  string
	trust      []byte
}

func prepareNativePrebuildBase(ctx context.Context, assignment Assignment, base string) (*nativePrebuildBase, error) {
	if assignment.nativeActorUID == "" {
		return nil, nil
	}
	if _, err := nativePrebuildContext(ctx, assignment); err != nil {
		return nil, err
	}
	trust, err := os.ReadFile(assignment.RegistryCAFile)
	roots := x509.NewCertPool()
	if err != nil || len(trust) > 2<<20 || strings.Contains(string(trust), "PRIVATE KEY") || !roots.AppendCertsFromPEM(trust) {
		return nil, errors.New("native prebuild public trust is unavailable")
	}
	if _, err := projectImageKey(base); err != nil {
		return nil, err
	}
	// Public trust and the bundled networkless transport script are build
	// inputs. Actor/Attempt IDs and private local image IDs are not portable
	// recipe inputs: another admitted Actor can consume this exact artifact.
	sum := sha256.New()
	sum.Write([]byte("factory-native-prebuild-transport-v1\x00"))
	sum.Write(trust)
	sum.Write([]byte{0})
	sum.Write(nativeDependencyTransport)
	return &nativePrebuildBase{assignment: assignment, base: base, transport: hex.EncodeToString(sum.Sum(nil)), trust: trust}, nil
}

// Activation belongs only to a new producer's build, not recipe matching or
// completed-result reuse. Consumers must not need the producer's local graph.
func activateNativePrebuildBase(ctx context.Context, selected *nativePrebuildBase) (string, error) {
	assignment := selected.assignment
	if _, err := nativePrebuildContext(ctx, assignment); err != nil {
		return "", err
	}
	if err := acquireProjectImage(ctx, selected.base); err != nil {
		return "", err
	}
	image, err := nativeDependencyImage(ctx, assignment, selected.base, selected.trust)
	if err != nil {
		return "", err
	}
	output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{index .Config.Labels \""+nativeDependencyLabel+"\"}}", image).Output()
	identity := strings.TrimSpace(string(output))
	if err != nil || !regexpIdentity(identity) {
		return "", errors.New("native prebuild base reference is unconfirmed")
	}
	assignment.preparedRootFSImage = image
	assignment.nativeDependencyReference = "factory-native-dependencies:" + identity
	if err := requireNativeDependencyReference(ctx, assignment); err != nil {
		return "", err
	}
	selected.assignment, selected.reference = assignment, assignment.nativeDependencyReference
	return selected.reference, nil
}
