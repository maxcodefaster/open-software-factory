package repositoryurl

import "testing"

func TestKubernetesServiceTransport(t *testing.T) {
	for _, value := range []string{
		"http://factory.portable.svc:3000/internal/source/repository",
		"http://forgejo.factory-one.svc:3000/team/project.git",
		"http://a.b.svc/project.git",
	} {
		if !Valid(value) {
			t.Fatalf("qualified Kubernetes Service rejected: %s", value)
		}
	}
	for _, value := range []string{
		"http://factory.portable.svc.attacker.example/project.git",
		"http://factory..svc/project.git",
		"http://factory.-namespace.svc/project.git",
		"http://factory.namespace-.svc/project.git",
		"http://factory.svc/project.git",
		"http://secret@factory.portable.svc/project.git",
		"http://example.com/project.git",
	} {
		if Valid(value) {
			t.Fatalf("unsafe Service-like repository admitted: %s", value)
		}
	}
}

func TestPrivateHostPermitsOnlyLocalAndInstallationHosts(t *testing.T) {
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "host.orb.internal", "factory.portable.svc", "10.0.0.5", "192.168.1.2", "fd00::2"} {
		if !PrivateHost(host) {
			t.Fatalf("%s should be private", host)
		}
	}
	for _, host := range []string{"factory.example.com", "203.0.113.10", "8.8.8.8", "", "evil.svc.example.com", "fe80::1%eth0"} {
		if PrivateHost(host) {
			t.Fatalf("%s should not be private", host)
		}
	}
}
