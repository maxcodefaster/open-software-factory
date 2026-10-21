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
