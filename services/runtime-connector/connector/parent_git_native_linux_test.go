package connector

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func TestNativeIntegrationAndPushKeepCredentialsOutsideSource(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	root, err := os.MkdirTemp("", "factory-native-remote-proof-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	privateScratch := filepath.Join(root, "parent-private")
	if err := os.Mkdir(privateScratch, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", privateScratch)
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	workspace := filepath.Join(root, "project")
	if err := os.Mkdir(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	developmentOwned := false
	git := func(directory string, arguments ...string) string {
		t.Helper()
		command := hardenedGitCommand(context.Background(), directory, nil, arguments...)
		if directory == workspace && developmentOwned {
			// Observational status can refresh index metadata. Match the real
			// native owner instead of making the test itself replace it as root.
			command = workspaceGitCommand(context.WithValue(context.Background(), nativeCommitGitKey{}, true), directory, arguments...)
		}
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("owned Git: %v: %s", err, output)
		}
		return strings.TrimSpace(string(output))
	}
	git(workspace, "init", "--initial-branch=main")
	git(workspace, "config", "user.name", "Owned")
	git(workspace, "config", "user.email", "owned@example.invalid")
	commitFile(t, workspace, "app.txt", "seed\n")
	git(workspace, "add", "-A")
	git(workspace, "commit", "-m", "seed")
	git(workspace, "checkout", "-b", "ticket")
	commitFile(t, workspace, "app.txt", "ticket implementation\n")
	git(workspace, "add", "-A")
	git(workspace, "commit", "-m", "ticket")
	expected := git(workspace, "rev-parse", "HEAD")
	git(workspace, "checkout", "main")
	commitFile(t, workspace, "other.txt", "integrated source\n")
	commitFile(t, workspace, ".gitattributes", "other.txt filter=owned\n")
	git(workspace, "add", "-A")
	git(workspace, "commit", "-m", "upstream")
	parent := git(workspace, "rev-parse", "HEAD")
	git(workspace, "checkout", "ticket")
	remote := filepath.Join(root, "remote.git")
	// A local fixture clone otherwise hardlinks the original Source objects into
	// its remote. Real authenticated HTTPS transport never does that, and complete
	// Source checkpoints correctly refuse links leaving their owned checkout.
	git("", "clone", "--bare", "--no-hardlinks", "--", workspace, remote)
	git(remote, "config", "http.receivepack", "true")
	execPath := git("", "--exec-path")
	backend := &cgi.Handler{Path: filepath.Join(execPath, "git-http-backend"), Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER=owned"}}
	var authenticated, pushes atomic.Int64
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "owned" || password != "owned-private-native-password" {
			w.Header().Set("WWW-Authenticate", `Basic realm="owned"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		authenticated.Add(1)
		if strings.HasPrefix(r.URL.Path, "/redirect.git/") {
			http.Redirect(w, r, "/remote.git/"+strings.TrimPrefix(r.URL.Path, "/redirect.git/")+"?"+r.URL.RawQuery, http.StatusFound)
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/git-receive-pack") {
			pushes.Add(1)
		}
		backend.ServeHTTP(w, r)
	}))
	defer server.Close()
	ca := filepath.Join(root, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_SSL_CAINFO", ca)
	t.Setenv("FACTORY_CONNECTOR_TOKEN", "owned-private-parent-capability")
	proof := filepath.Join(workspace, ".git", "filter-proof")
	filter := filepath.Join(root, "filter")
	script := "#!/bin/sh\nprintf '%s:%s:%s\\n' \"$(id -u)\" \"${FACTORY_GIT_PASSWORD-unset}\" \"${FACTORY_CONNECTOR_TOKEN-unset}\" >> '" + proof + "'\ncat\n"
	if err := os.WriteFile(filter, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	git(workspace, "config", "filter.owned.smudge", filter)
	git(workspace, "config", "filter.owned.clean", "cat")
	if err := filepath.WalkDir(workspace, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(name, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	developmentOwned = true
	assignment := Assignment{WorkspaceFolder: workspace, nativeActorUID: "owned-native-actor"}
	message := Message{Action: "git-prepare-integration", OperationID: "owned-native-integration", ExpectedSHA: expected, MergeParentSHA: parent, RepositoryURL: server.URL + "/remote.git", Branch: "ticket", Username: "owned", Password: "owned-private-native-password", CommitMessage: "Integrate owned upstream", AuthorName: "Factory", AuthorEmail: "owned@example.invalid"}
	result := handleParentOperation(context.Background(), assignment, message)
	if result.Error != "" || !validCommitSHA(result.CommitSHA) {
		t.Fatalf("native integration: %s", result.Error)
	}
	if actual := git(workspace, "show", "-s", "--format=%P", result.CommitSHA); actual != expected+" "+parent {
		t.Fatal("native integration lost its exact parents")
	}
	observed, err := os.ReadFile(proof)
	if err != nil || strings.TrimSpace(string(observed)) != "1000:unset:unset" {
		t.Fatalf("Project filter received privileged identity or credentials: %q, %v", observed, err)
	}
	if authenticated.Load() == 0 {
		t.Fatal("native integration did not authenticate over verified TLS")
	}
	for _, failure := range []string{"credentials", "trust", "redirect"} {
		blocked := message
		blocked.OperationID = "owned-native-refused-" + failure
		blocked.ExpectedSHA = result.CommitSHA
		if failure == "credentials" {
			blocked.Password = "owned-wrong-password"
		} else if failure == "redirect" {
			blocked.RepositoryURL = server.URL + "/redirect.git"
		} else {
			t.Setenv("GIT_SSL_CAINFO", filepath.Join(root, "absent-ca.pem"))
		}
		if refused := handleParentOperation(context.Background(), assignment, blocked); refused.Error != "integration source could not be fetched" {
			t.Fatalf("native integration relaxed %s: %s", failure, refused.Error)
		}
		t.Setenv("GIT_SSL_CAINFO", ca)
		if current := git(workspace, "rev-parse", "HEAD"); current != result.CommitSHA {
			t.Fatal("refused native fetch changed retained HEAD")
		}
	}
	commitFile(t, workspace, "later-private.txt", "retained later work\n")
	if err := os.Chown(filepath.Join(workspace, "later-private.txt"), 1000, 1000); err != nil {
		t.Fatal(err)
	}
	message.Action = "git-observe-commit"
	if recovered := handleParentOperation(context.Background(), assignment, message); recovered.Error != "" || recovered.CommitSHA != result.CommitSHA {
		t.Fatal("exact native integration recovery failed")
	}
	message.Action = "git-push"
	message.CommitSHA = result.CommitSHA
	if pushed := handleParentOperation(context.Background(), assignment, message); pushed.Error != "" || pushed.RemoteSHA != result.CommitSHA {
		t.Fatalf("native push: %s", pushed.Error)
	}
	before := pushes.Load()
	if before != 1 {
		t.Fatalf("expected one actual remote push, got %d", before)
	}
	if pushed := handleParentOperation(context.Background(), assignment, message); pushed.Error != "" || pushed.RemoteSHA != result.CommitSHA {
		t.Fatal("native push observation failed")
	}
	if pushes.Load() != before {
		t.Fatal("completed native push was replayed")
	}
	if actual := git(workspace, "status", "--porcelain"); actual != "?? later-private.txt" {
		t.Fatal("native integration/push discarded later work")
	}
	if err := filepath.WalkDir(workspace, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != 1000 || stat.Gid != 1000 || stat.Mode&07000 != 0 {
			t.Errorf("native Git changed Source ownership/mode: %s", name)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	source, err := workspacefiles.Open(workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	archive, err := os.CreateTemp(root, "archive-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if _, err := source.ExportBundle(archive); err != nil {
		t.Fatalf("native remote Git prevented complete Source checkpoint: %v", err)
	}
	if entries, err := os.ReadDir(privateScratch); err != nil || len(entries) != 0 {
		t.Fatalf("Parent-private Git/askpass scratch was retained: %v", err)
	}
}
