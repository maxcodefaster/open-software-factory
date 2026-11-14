package connector

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nativePrebuildTransportFixture(t *testing.T, assignment Assignment) {
	t.Helper()
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	t.Setenv("DOCKER_HOST", "unix:///run/user/1000/docker.sock")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:8888")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:8888")
}

func TestPrebuildNativeProxyRequiresTheVerifiedAssignmentAndNeverExportsPrivateEnvironment(t *testing.T) {
	assignment := validAssignment()
	assignment.nativeActorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	nativePrebuildTransportFixture(t, assignment)
	t.Setenv("FACTORY_PARENT_CONNECTOR_TOKEN", "private-parent-fixture")
	t.Setenv("PRIVATE_RUNTIME_ONLY", "private-runtime-fixture")
	ctx, err := nativePrebuildContext(context.Background(), Assignment{})
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.Join(prebuildCommand(ctx, t.TempDir(), "true").Env, "\n")
	if strings.Contains(legacy, "PROXY=") || strings.Contains(legacy, "private-") {
		t.Fatal("an environment variable alone enabled native transport or exported credentials")
	}
	ctx, err = nativePrebuildContext(context.Background(), assignment)
	if err != nil {
		t.Fatal(err)
	}
	selected := strings.Join(prebuildCommand(ctx, t.TempDir(), "true").Env, "\n")
	if !strings.Contains(selected, "DOCKER_HOST=unix:///run/user/1000/docker.sock") || !strings.Contains(selected, "HTTPS_PROXY=http://127.0.0.1:8888") || !strings.Contains(selected, "NO_PROXY=localhost,127.0.0.1") || strings.Contains(selected, "private-") {
		t.Fatal("native build lost its private proxy or acquired private credentials")
	}
	t.Setenv("HTTP_PROXY", "http://another-host:8888")
	if _, err := nativePrebuildContext(context.Background(), assignment); err == nil {
		t.Fatal("native prebuild admitted a different proxy")
	}
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:8888")
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "another-actor")
	if _, err := nativePrebuildContext(context.Background(), assignment); err == nil {
		t.Fatal("native prebuild admitted a changed Actor identity")
	}
}

func TestNativePrebuildRecipeHashesPublicTransportButNeverPrivateImageOrActorFacts(t *testing.T) {
	input := prebuildInput{Version: 3, NativeTransportSHA256: strings.Repeat("a", 64),
		nativeBase: &nativePrebuildBase{assignment: Assignment{RuntimeAttemptID: "private-attempt"}, reference: "private-local-reference"}}
	before := prebuildIdentity(input)
	encoded, err := json.Marshal(input)
	if err != nil || strings.Contains(string(encoded), "private-") {
		t.Fatal("private native base facts entered the portable recipe")
	}
	input.nativeBase.assignment.RuntimeAttemptID = "another-attempt"
	input.nativeBase.reference = "another-local-reference"
	if prebuildIdentity(input) != before {
		t.Fatal("another admitted Actor cannot match the same public recipe")
	}
	input.NativeTransportSHA256 = strings.Repeat("b", 64)
	if prebuildIdentity(input) == before {
		t.Fatal("changed public transport inherited an earlier artifact")
	}
	var authored prebuildConfiguration
	if json.Unmarshal([]byte(`{"nativeBase":{"reference":"foreign-reference"}}`), &authored) != nil || authored.nativeBase != nil {
		t.Fatal("Source enabled the private native base capability")
	}
}

func prebuildTrustCertificate(t *testing.T, name string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Unix(0, 0), NotAfter: time.Unix(2_000_000_000, 0),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestNativePrebuildCertificateOrderAndDuplicatesDoNotChangePortableBuildInputs(t *testing.T) {
	first, second := prebuildTrustCertificate(t, "first"), prebuildTrustCertificate(t, "second")
	assignment := validAssignment()
	assignment.nativeActorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	assignment.RegistryCAFile = filepath.Join(t.TempDir(), "public-trust.pem")
	nativePrebuildTransportFixture(t, assignment)
	base := func(bundle []byte) *nativePrebuildBase {
		t.Helper()
		if err := os.WriteFile(assignment.RegistryCAFile, bundle, 0600); err != nil {
			t.Fatal(err)
		}
		selected, err := prepareNativePrebuildBase(context.Background(), assignment, projectImage("a"))
		if err != nil {
			t.Fatal(err)
		}
		return selected
	}
	producer := base(append(append([]byte(nil), first...), second...))
	assignment.nativeActorUID = "559d9659-2148-4df2-8263-0af82e2c979d"
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
	consumer := base(append(append(append([]byte("\n"), second...), first...), second...))
	if producer.transport != consumer.transport {
		t.Fatal("the same certificate set in another Actor cannot match the producer's prebuild fingerprint")
	}
	if !bytes.Equal(producer.trust, consumer.trust) {
		t.Fatal("portable identity was normalized but actual embedded build trust was not")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(consumer.trust) || len(roots.Subjects()) != 2 {
		t.Fatal("canonical build trust changed the admitted certificate set")
	}
	changed := base(append(append([]byte(nil), first...), prebuildTrustCertificate(t, "third")...))
	if changed.transport == consumer.transport {
		t.Fatal("different certificate authority reused the earlier prepared image")
	}
}

func TestNativePrebuildCanonicalTrustRejectsInvalidOrPrivateMaterial(t *testing.T) {
	certificate := prebuildTrustCertificate(t, "admitted")
	for name, trust := range map[string][]byte{
		"empty":            nil,
		"invalid DER":      pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("invalid")}),
		"private key":      append(append([]byte(nil), certificate...), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("private")})...),
		"non-certificate":  append(append([]byte(nil), certificate...), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte("public")})...),
		"trailing garbage": append(append([]byte(nil), certificate...), []byte("not a certificate")...),
		"oversized":        bytes.Repeat([]byte(" "), (2<<20)+1),
	} {
		t.Run(name, func(t *testing.T) {
			if trust, err := canonicalNativePrebuildTrust(trust); err == nil || trust != nil {
				t.Fatal("invalid material was normalized into accepted build trust")
			}
		})
	}
}
