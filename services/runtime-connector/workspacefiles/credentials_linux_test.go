package workspacefiles

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestSourceServingPermanentlyDropsInitializerPrivileges(t *testing.T) {
	if os.Getenv("FACTORY_SOURCE_CREDENTIAL_CHILD") == "1" {
		if err := DropSourcePrivileges(); err != nil {
			t.Fatal(err)
		}
		if os.Getuid() != 101000 || os.Geteuid() != 101000 || os.Getgid() != 101000 || os.Getegid() != 101000 {
			t.Fatal("source retained initializer identity")
		}
		groups, err := os.Getgroups()
		if err != nil || len(groups) != 0 {
			t.Fatal("source retained supplementary groups", groups, err)
		}
		status, err := os.ReadFile("/proc/self/status")
		if err != nil || !strings.Contains(string(status), "CapEff:\t0000000000000000") || !strings.Contains(string(status), "NoNewPrivs:\t1") {
			t.Fatal("source retained capabilities or privilege escalation", err)
		}
		threads, err := os.ReadDir("/proc/self/task")
		if err != nil {
			t.Fatal(err)
		}
		for _, thread := range threads {
			status, err := os.ReadFile(filepath.Join("/proc/self/task", thread.Name(), "status"))
			if os.IsNotExist(err) {
				continue // A runtime thread may exit between listing and observation.
			}
			if err != nil || !strings.Contains(string(status), "CapEff:\t0000000000000000") || !strings.Contains(string(status), "NoNewPrivs:\t1") || !strings.Contains(string(status), "Uid:\t101000\t101000\t101000\t101000") || !strings.Contains(string(status), "Gid:\t101000\t101000\t101000\t101000") {
				t.Fatal("a source thread retained initializer authority", thread.Name(), err)
			}
		}
		if err := unix.Setuid(0); err == nil {
			t.Fatal("source regained initializer privileges")
		}
		return
	}
	if os.Geteuid() != 0 {
		t.Skip("credential transition requires a Linux root subprocess")
	}
	command := exec.Command(os.Args[0], "-test.run=^TestSourceServingPermanentlyDropsInitializerPrivileges$")
	command.Env = append(os.Environ(), "FACTORY_SOURCE_CREDENTIAL_CHILD=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("credential transition failed: %s %v", output, err)
	}
}
