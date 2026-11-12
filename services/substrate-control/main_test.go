package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	ate "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type testControl struct {
	ate.UnimplementedControlServer
	suspendMode   ate.DurabilityMode
	deleteOptions *ate.DeleteOptions
}

func TestLifecycleContextUsesNativeBudgetsAndStillHonorsCancellation(t *testing.T) {
	for _, method := range []string{"GetActor", "CreateActor", "DeleteActor", "ResumeActor", "SuspendActor"} {
		t.Run(method, func(t *testing.T) {
			parent, stop := context.WithCancel(context.Background())
			ctx, cancel := commandContext(parent, method)
			defer cancel()
			_, limited := ctx.Deadline()
			lifecycle := method == "ResumeActor" || method == "SuspendActor"
			if limited == lifecycle {
				t.Fatal("wrong lifecycle/read deadline policy")
			}
			stop()
			select {
			case <-ctx.Done():
			default:
				t.Fatal("caller cancellation was lost")
			}
		})
	}
	parent, stop := context.WithDeadline(context.Background(), time.Now().Add(time.Hour))
	defer stop()
	ctx, cancel := commandContext(parent, "SuspendActor")
	defer cancel()
	a, _ := parent.Deadline()
	b, ok := ctx.Deadline()
	if !ok || !a.Equal(b) {
		t.Fatal("explicit caller deadline was changed")
	}
}

func (s *testControl) GetActor(ctx context.Context, r *ate.GetActorRequest) (*ate.Actor, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	if got := md.Get("authorization"); len(got) != 1 || got[0] != "Bearer rotated-api-audience-token" {
		return nil, status.Error(codes.Unauthenticated, "unaccepted projected audience/token")
	}
	return &ate.Actor{Metadata: &ate.ResourceMetadata{Name: r.Actor.Name, Atespace: r.Actor.Atespace, Uid: "original-uid", Version: 7}}, nil
}
func (s *testControl) SuspendActor(_ context.Context, r *ate.SuspendActorRequest) (*ate.SuspendActorResponse, error) {
	s.suspendMode = r.GetOptions().GetMode()
	return &ate.SuspendActorResponse{}, nil
}
func (s *testControl) DeleteActor(_ context.Context, r *ate.DeleteActorRequest) (*ate.Actor, error) {
	s.deleteOptions = r.Options
	return &ate.Actor{}, nil
}
func (s *testControl) CreateAtespace(_ context.Context, r *ate.CreateAtespaceRequest) (*ate.Atespace, error) {
	return r.Atespace, nil
}
func (s *testControl) CreateAtespaceAccessPolicy(_ context.Context, r *ate.CreateAtespaceAccessPolicyRequest) (*ate.AccessPolicy, error) {
	return r.AccessPolicy, nil
}
func (s *testControl) CreateActorTemplate(_ context.Context, r *ate.CreateActorTemplateRequest) (*ate.ActorTemplate, error) {
	return r.ActorTemplate, nil
}

func testCertificate(t *testing.T, name string) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	k, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(ca, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: k}))
	if err != nil {
		t.Fatal(err)
	}
	return pair, ca
}

func TestPublicGRPCTrustTokenRotationAndSafety(t *testing.T) {
	pair, ca := testCertificate(t, "api.ate-system.svc")
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}})))
	control := &testControl{}
	ate.RegisterControlServer(s, control)
	go func() { _ = s.Serve(l) }()
	defer s.Stop()
	dir := t.TempDir()
	c := command{Endpoint: l.Addr().String(), ServerName: "api.ate-system.svc", CAFile: filepath.Join(dir, "ca"), TokenFile: filepath.Join(dir, "token"), Method: "GetActor", Request: json.RawMessage(`{"actor":{"atespace":"owned","name":"original"}}`)}
	write := func(p string, b []byte) {
		t.Helper()
		if err := os.WriteFile(p, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(c.CAFile, ca)
	write(c.TokenFile, []byte("wrong-audience-token"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := call(ctx, c); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("audience negative control: %v", err)
	}
	write(c.TokenFile, []byte("rotated-api-audience-token"))
	result, err := call(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if result.(*ate.Actor).Metadata.Version != 7 {
		t.Fatal("generated protobuf response lost version")
	}
	_, wrongCA := testCertificate(t, "another.invalid")
	write(c.CAFile, wrongCA)
	short, stop := context.WithTimeout(context.Background(), 200*time.Millisecond)
	if _, err := call(short, c); err == nil {
		t.Fatal("untrusted CA accepted")
	}
	stop()
	write(c.CAFile, ca)
	if _, err := call(ctx, c); err != nil {
		t.Fatalf("CA file rotation: %v", err)
	}
	c.ServerName = "wrong.invalid"
	if _, err := call(ctx, c); err == nil {
		t.Fatal("unverified serving name accepted")
	}
	c.ServerName = "api.ate-system.svc"
	c.Method = "SuspendActor"
	c.Request = json.RawMessage(`{"actor":{"atespace":"owned","name":"original"}}`)
	if _, err := call(ctx, c); err == nil {
		t.Fatal("asynchronous default accepted")
	}
	c.Request = json.RawMessage(`{"actor":{"atespace":"owned","name":"original"},"options":{"mode":"DURABILITY_MODE_SYNCHRONOUS"}}`)
	if _, err := call(ctx, c); err != nil {
		t.Fatal(err)
	}
	if control.suspendMode != ate.DurabilityMode_DURABILITY_MODE_SYNCHRONOUS {
		t.Fatal("wrong wire durability")
	}
	c.Method = "DeleteActor"
	c.Request = json.RawMessage(`{"actor":{"atespace":"owned","name":"original"}}`)
	if _, err := call(ctx, c); err == nil {
		t.Fatal("name-only delete accepted")
	}
	c.Request = json.RawMessage(`{"actor":{"atespace":"owned","name":"original"},"options":{"uid":"original-uid","version":"7"}}`)
	if _, err := call(ctx, c); err != nil {
		t.Fatal(err)
	}
	if control.deleteOptions.Uid != "original-uid" || control.deleteOptions.Version != 7 {
		t.Fatal("delete preconditions lost")
	}
	c.Method = "CreateAtespace"
	if _, err := call(ctx, c); err == nil {
		t.Fatal("unbound provisioning accepted")
	}
	c.Request = json.RawMessage(`{"atespace":{"metadata":{"name":"fa-0123456789abcdef0123456789abcdef"}}}`)
	if _, err := call(ctx, c); err != nil {
		t.Fatalf("normal native atespace creation: %v", err)
	}
	c.Method = "CreateAtespaceAccessPolicy"
	c.Request = json.RawMessage(`{"atespace":{"name":"fa-0123456789abcdef0123456789abcdef"},"accessPolicy":{"metadata":{"name":"default"},"bindings":[{"role":"editor","members":["user:system:serviceaccount:factory:control"]}]}}`)
	if _, err := call(ctx, c); err != nil {
		t.Fatalf("normal native editor grant: %v", err)
	}
	c.Request = json.RawMessage(`{"atespace":{"name":"fa-0123456789abcdef0123456789abcdef"},"accessPolicy":{"metadata":{"name":"default"},"bindings":[{"role":"owner","members":["user:system:serviceaccount:factory:control"]}]}}`)
	if _, err := call(ctx, c); err == nil {
		t.Fatal("native provisioning escalated to owner")
	}
	c.Method = "CreateActorTemplate"
	c.Request = json.RawMessage(`{"actorTemplate":{"metadata":{"name":"runtime","atespace":"fa-0123456789abcdef0123456789abcdef"},"snapshotConfig":{"preferredFidelity":"SNAPSHOT_FIDELITY_ROOTFS","goldenSnapshotConfig":{"mode":"GOLDEN_SNAPSHOT_MODE_DISABLED"}}}}`)
	if _, err := call(ctx, c); err != nil {
		t.Fatalf("normal native template: %v", err)
	}
	c.Method = "CreateGlobalAccessPolicy"
	if _, err := call(ctx, c); err == nil {
		t.Fatal("global policy administration exposed")
	}
}
