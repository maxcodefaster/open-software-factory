//go:build linux || darwin

package connector

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestBrowserConfigurationWithBootstrapUmask(t *testing.T) {
	if os.Getenv("FACTORY_BROWSER_CONFIG_FIXTURE") != "1" {
		// Isolate the process-wide umask from the ordinary test process.
		command := exec.Command(os.Args[0], "-test.run=^TestBrowserConfigurationWithBootstrapUmask$", "-test.v")
		command.Env = append(os.Environ(), "FACTORY_BROWSER_CONFIG_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("production umask fixture failed: %v: %s", err, output)
		}
		return
	}
	syscall.Umask(0077)
	root := os.Getenv("FACTORY_BROWSER_CONFIG_ROOT")
	native := root != ""
	if !native {
		root = t.TempDir()
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	channels := []Channel{
		{Name: "app", Kind: "app", Target: "http://127.0.0.1:4321"},
		{Name: "app-forms-api", Kind: "app", Target: "http://127.0.0.1:3001"},
		{Name: "app-forms-admin", Kind: "app", Target: "http://127.0.0.1:3002"},
		{Name: "app-forms-web", Kind: "app", Target: "http://127.0.0.1:4323"},
	}
	apps, err := json.Marshal(channels)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeBrowserConfig(root, "apps.json", apps); err != nil {
		t.Fatal(err)
	}
	scope := browserRuntimeRequest{SessionID: "owned-browser-config", ExpiresAt: time.Now().Add(25 * time.Second)}
	if err := writeBrowserAuthority(root, scope); err != nil {
		t.Fatal(err)
	}
	for path, mode := range map[string]os.FileMode{
		root: 0700, filepath.Join(root, "config"): 0755,
		filepath.Join(root, "config", "apps.json"):      0444,
		filepath.Join(root, "config", "authority.json"): 0444,
	} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("browser configuration mode differs: %s want %o: %v", path, mode, err)
		}
	}
	if _, err := readBrowserAuthority(filepath.Join(root, "config", "authority.json")); err != nil {
		t.Fatal("configured browser lease is unreadable", err)
	}
	if native {
		// The owned Docker proof starts the unchanged packaged proxy as UID 1000
		// against these actual production-writer outputs, never a copied fixture.
		socket := filepath.Join(root, "socket")
		if err := os.MkdirAll(filepath.Join(socket, "config"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(socket, 1000, 1000); err != nil {
			t.Fatal(err)
		}
	}
}
