// substrate-control is a one-RPC process boundary, not a lifecycle controller.
// It uses the official v1.0.0 generated public client. Nothing is retried.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	ate "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type command struct {
	Endpoint   string          `json:"endpoint"`
	ServerName string          `json:"serverName"`
	CAFile     string          `json:"caFile"`
	TokenFile  string          `json:"tokenFile"`
	Method     string          `json:"method"`
	Request    json.RawMessage `json:"request"`
}

var factoryAtespace = regexp.MustCompile(`^fa-[a-f0-9]{32}$`)
var factoryEditor = regexp.MustCompile(`^user:system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$`)

func commandContext(parent context.Context, method string) (context.Context, context.CancelFunc) {
	// Substrate bounds checkpoint/upload and wakeup work. A separate three-minute
	// client deadline can cancel finalization after the checkpoint has committed.
	if method == "SuspendActor" || method == "ResumeActor" {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, 180*time.Second)
}

func call(ctx context.Context, c command) (proto.Message, error) {
	if c.Endpoint == "" || c.ServerName != "api.ate-system.svc" || c.CAFile == "" || c.TokenFile == "" {
		return nil, errors.New("explicit endpoint, serving name api.ate-system.svc and projected CA/token files required")
	}
	// Each invocation reopens the projected files (including Kubernetes symlink
	// rotation). Neither bootstrap credentials nor an insecure TLS mode exist.
	ca, err := os.ReadFile(c.CAFile)
	if err != nil {
		return nil, fmt.Errorf("read serving CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid serving CA")
	}
	token, err := os.ReadFile(c.TokenFile)
	if err != nil {
		return nil, fmt.Errorf("read projected token: %w", err)
	}
	if strings.TrimSpace(string(token)) == "" {
		return nil, errors.New("empty projected token")
	}
	conn, err := grpc.NewClient(c.Endpoint, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
		MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: c.ServerName,
	})), grpc.WithDisableRetry())
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+strings.TrimSpace(string(token)))
	client := ate.NewControlClient(conn)
	decode := func(m proto.Message) error { return protojson.Unmarshal(c.Request, m) }
	switch c.Method {
	case "CreateAtespace":
		r := &ate.CreateAtespaceRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		if !factoryAtespace.MatchString(r.GetAtespace().GetMetadata().GetName()) {
			return nil, errors.New("deterministic Factory atespace name required")
		}
		return client.CreateAtespace(ctx, r)
	case "GetAtespaceAccessPolicy":
		r := &ate.GetAtespaceAccessPolicyRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.GetAtespaceAccessPolicy(ctx, r)
	case "CreateAtespaceAccessPolicy":
		r := &ate.CreateAtespaceAccessPolicyRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		p := r.GetAccessPolicy()
		if !factoryAtespace.MatchString(r.GetAtespace().GetName()) || p.GetMetadata().GetName() != "default" || p.GetMetadata().GetAtespace() != "" || len(p.GetBindings()) != 1 || p.GetBindings()[0].GetRole() != "editor" || len(p.GetBindings()[0].GetMembers()) != 1 || !factoryEditor.MatchString(p.GetBindings()[0].GetMembers()[0]) {
			return nil, errors.New("one deterministic Factory atespace editor grant required")
		}
		return client.CreateAtespaceAccessPolicy(ctx, r)
	case "CreateActorTemplate":
		r := &ate.CreateActorTemplateRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		t := r.GetActorTemplate()
		if !factoryAtespace.MatchString(t.GetMetadata().GetAtespace()) || t.GetMetadata().GetName() != "runtime" || t.GetSnapshotConfig().GetPreferredFidelity() != ate.SnapshotFidelity_SNAPSHOT_FIDELITY_ROOTFS || t.GetSnapshotConfig().GetGoldenSnapshotConfig().GetMode() != ate.GoldenSnapshotMode_GOLDEN_SNAPSHOT_MODE_DISABLED {
			return nil, errors.New("Factory ROOTFS runtime template with golden snapshots disabled required")
		}
		return client.CreateActorTemplate(ctx, r)
	case "GetAtespace":
		r := &ate.GetAtespaceRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.GetAtespace(ctx, r)
	case "GetActorTemplate":
		r := &ate.GetActorTemplateRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.GetActorTemplate(ctx, r)
	case "GetActor":
		r := &ate.GetActorRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.GetActor(ctx, r)
	case "GetActorEgressPolicy":
		r := &ate.GetActorEgressPolicyRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.GetActorEgressPolicy(ctx, r)
	case "CreateActorEgressPolicy":
		r := &ate.CreateActorEgressPolicyRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.CreateActorEgressPolicy(ctx, r)
	case "CreateActor":
		r := &ate.CreateActorRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.CreateActor(ctx, r)
	case "ResumeActor":
		r := &ate.ResumeActorRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		return client.ResumeActor(ctx, r)
	case "SuspendActor":
		r := &ate.SuspendActorRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		if r.GetOptions().GetMode() != ate.DurabilityMode_DURABILITY_MODE_SYNCHRONOUS {
			return nil, errors.New("synchronous durability required")
		}
		return client.SuspendActor(ctx, r)
	case "DeleteActor":
		r := &ate.DeleteActorRequest{}
		if err := decode(r); err != nil {
			return nil, err
		}
		if r.GetOptions().GetUid() == "" || r.GetOptions().GetVersion() < 1 {
			return nil, errors.New("delete UID and version preconditions required")
		}
		return client.DeleteActor(ctx, r)
	default:
		return nil, errors.New("unsupported Factory native operation")
	}
}

func main() {
	var c command
	d := json.NewDecoder(io.LimitReader(os.Stdin, 2<<20))
	d.DisallowUnknownFields()
	err := d.Decode(&c)
	var result proto.Message
	if err == nil {
		parent, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		ctx, cancel := commandContext(parent, c.Method)
		defer cancel()
		result, err = call(ctx, c)
	}
	if err != nil {
		// Errors are data; credentials and request bodies are never logged.
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"error": map[string]string{"code": status.Code(err).String(), "message": err.Error()}})
		return
	}
	b, err := protojson.Marshal(result)
	if err != nil {
		fmt.Fprintln(os.Stderr, "encode native response failed")
		os.Exit(1)
	}
	fmt.Println(string(b))
}
