package connector

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeChildReceivesOnlyRestrictedTransportAndCopiedTrust(t *testing.T) {
	dir := nativeNetworkFixture(t)
	log := filepath.Join(dir, "docker.log")
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "")
	flags, err := nativeChildTransport(context.Background(), "owned-container", 7)
	if err != nil || len(flags) != 0 {
		t.Fatal("ordinary injection changed")
	}
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", "original-native-uid")
	t.Setenv("SSL_CERT_FILE", "/owned/trust.pem")
	t.Setenv("FACTORY_SUBSTRATE_BOOTSTRAP", "must-never-reach-child")
	flags, err = nativeChildTransport(context.Background(), "owned-container", 7)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(flags, " ")
	for _, expected := range []string{"FACTORY_SUBSTRATE_ACTOR_UID=original-native-uid", "SSL_CERT_FILE=/tmp/factory-native-trust-7.pem", "HTTPS_PROXY=http://172.18.0.1:8888", "NO_PROXY=localhost,127.0.0.1"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %s", expected)
		}
	}
	if strings.Contains(text, "must-never-reach-child") || strings.Contains(text, "/owned/trust.pem") {
		t.Fatal("infrastructure bootstrap leaked")
	}
	commands, _ := os.ReadFile(log)
	if !strings.Contains(string(commands), "cp /owned/trust.pem owned-container:/tmp/factory-native-trust-7.pem") || !strings.Contains(string(commands), "chmod 0444") {
		t.Fatal("trust was not copied and made readable")
	}
	t.Setenv("SSL_CERT_FILE", "")
	if _, err := nativeChildTransport(context.Background(), "owned-container", 7); err == nil {
		t.Fatal("missing trust accepted")
	}
}

func TestActorPrivateCgroupsRequireVerifiedBootstrapAndAbsentNamespaceFeature(t *testing.T) {
	a := Assignment{nativeActorUID: "original-native-actor"}
	if !nativeActorCgroups(a, a.nativeActorUID, os.ErrNotExist) {
		t.Fatal("qualified private Actor cgroups rejected")
	}
	for _, check := range []bool{
		nativeActorCgroups(Assignment{}, a.nativeActorUID, os.ErrNotExist),
		nativeActorCgroups(a, "foreign-actor", os.ErrNotExist),
		nativeActorCgroups(a, a.nativeActorUID, nil),
		nativeActorCgroups(a, a.nativeActorUID, os.ErrPermission),
	} {
		if check {
			t.Fatal("unverified or host cgroup namespace accepted")
		}
	}
}
