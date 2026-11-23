package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func sourceInitializeCLI(t *testing.T, executable string, input []byte, uid, gid uint32, args ...string) (string, error) {
	t.Helper()
	return sourceInitializeCLIEnvironment(t, executable, input, uid, gid, nil, args...)
}

func sourceInitializeCLIEnvironment(t *testing.T, executable string, input []byte, uid, gid uint32, environment []string, args ...string) (string, error) {
	t.Helper()
	command := exec.Command(executable, "-test.run=^TestSourceInitializeCLIChild$")
	command.Stdin = bytes.NewReader(input)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "FACTORY_SOURCE_INITIALIZE_CLI_TEST=1"}
	command.Env = append(command.Env, environment...)
	if len(args) > 0 {
		command.Env = append(command.Env, "FACTORY_SOURCE_INITIALIZE_EXTRA_ARG="+args[0])
	}
	if os.Geteuid() == 0 {
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{}}}
	}
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func sourceInitializeExecutable(t *testing.T) (string, string) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	directory, err := os.MkdirTemp("", "factory-source-initialize-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(directory, "connector.test")
	if err := os.WriteFile(executable, binary, 0555); err != nil {
		t.Fatal(err)
	}
	return executable, directory
}

func TestSourceInitializeCLIRequiresDevelopmentIdentityAndStrictBoundedJSON(t *testing.T) {
	executable, _ := sourceInitializeExecutable(t)
	for _, identity := range [][2]uint32{{0, 0}, {1000, 0}, {0, 1000}, {1001, 1000}} {
		output, err := sourceInitializeCLI(t, executable, []byte(`{}`), identity[0], identity[1])
		if err == nil || output != "Source initialization requires UID/GID 1000" {
			t.Fatalf("wrong service identity was not refused: %v: %s", err, output)
		}
	}
	for _, input := range []string{
		`{`, `null`, `{"extra":true}`, `{"initialization":{"extra":true}}`, `{} {}`, `{} trailing`,
		`{}` + strings.Repeat(" ", 65537),
	} {
		output, err := sourceInitializeCLI(t, executable, []byte(input), 1000, 1000)
		if err == nil || output != "Source initialization input is invalid" {
			t.Fatalf("unbounded/invalid CLI assignment was not refused: %v: %s", err, output)
		}
	}
	output, err := sourceInitializeCLI(t, executable, []byte(`{}`), 1000, 1000, "--root=untrusted")
	if err == nil || output != "source-initialize accepts only its fixed stdin assignment" {
		t.Fatalf("source initializer accepted arguments: %v: %s", err, output)
	}
}

func sourceInitializeGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "safe.directory=" + directory, "-C", directory}, args...)...)
	command.Env = []string{"PATH=/usr/bin:/bin", "HOME=/tmp", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture Git: %v: %s", err, output)
	}
	return strings.TrimSpace(string(output))
}

func sourceInitializeRepository(t *testing.T, directory string) (string, string) {
	t.Helper()
	repository := filepath.Join(directory, "repository")
	if err := os.Mkdir(repository, 0755); err != nil {
		t.Fatal(err)
	}
	git := func(directory string, args ...string) string {
		t.Helper()
		return sourceInitializeGit(t, directory, args...)
	}
	git(repository, "init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(repository, "source.txt"), []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	git(repository, "add", ".")
	git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@factory.invalid", "commit", "-m", "source")
	// Local fixture Git also enforces repository ownership on clone.
	if err := filepath.WalkDir(repository, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chown(path, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	return repository, git(repository, "rev-parse", "HEAD")
}

func sourceInitializePrivateRoot(t *testing.T, directory, name string) string {
	t.Helper()
	root := filepath.Join(directory, name)
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(root, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestSourceInitializeCLIPublishesAndRetainsDirtyCheckout(t *testing.T) {
	executable, directory := sourceInitializeExecutable(t)
	repository, revision := sourceInitializeRepository(t, directory)
	root := sourceInitializePrivateRoot(t, directory, "private")
	input, _ := json.Marshal(map[string]any{"root": root, "initialization": map[string]string{
		"workspaceId": "owned-workspace", "projectId": "owned-project", "revision": revision,
		"repositoryUrl": "file://" + repository, "originUrl": "https://forge.factory.invalid/owned.git", "branch": "main",
	}})
	if output, err := sourceInitializeCLI(t, executable, input, 1000, 1000); err != nil {
		t.Fatalf("Source CLI initialization failed: %v: %s", err, output)
	}
	canonical := filepath.Join(root, "project")
	if got := sourceInitializeGit(t, canonical, "remote", "get-url", "origin"); got != "https://forge.factory.invalid/owned.git" {
		t.Fatal("clone transport became the saved origin")
	}
	if err := os.WriteFile(filepath.Join(canonical, "source.txt"), []byte("human edit"), 0644); err != nil {
		t.Fatal(err)
	}
	if output, err := sourceInitializeCLI(t, executable, input, 1000, 1000); err != nil {
		t.Fatalf("Source CLI recovery failed: %v: %s", err, output)
	}
	content, err := os.ReadFile(filepath.Join(canonical, "source.txt"))
	if err != nil || string(content) != "human edit" {
		t.Fatal("CLI recovery overwrote human Source")
	}
	if got := sourceInitializeGit(t, canonical, "symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Fatal("CLI did not retain the requested personal branch")
	}
	if err := filepath.WalkDir(canonical, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		identity := info.Sys().(*syscall.Stat_t)
		if identity.Uid != 1000 || identity.Gid != 1000 {
			t.Error("CLI published Source with another identity")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSourceInitializeCLIRejectsUnsafeParentsAndAuthorization(t *testing.T) {
	executable, directory := sourceInitializeExecutable(t)
	repository, revision := sourceInitializeRepository(t, directory)
	private := sourceInitializePrivateRoot(t, directory, "private")
	shared := sourceInitializePrivateRoot(t, directory, "shared")
	if err := os.Chmod(shared, 0755); err != nil {
		t.Fatal(err)
	}
	foreign := sourceInitializePrivateRoot(t, directory, "foreign")
	if err := os.Chown(foreign, 0, 0); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	initialization := map[string]string{
		"workspaceId": "owned-workspace", "projectId": "owned-project", "revision": revision,
		"repositoryUrl": "file://" + repository, "originUrl": "file://" + repository,
	}
	for _, root := range []string{"relative", "/", private + "/../private", shared, foreign, link} {
		input, _ := json.Marshal(map[string]any{"root": root, "initialization": initialization})
		if output, err := sourceInitializeCLI(t, executable, input, 1000, 1000); err == nil ||
			!strings.HasPrefix(output, "Source initialization requires ") {
			t.Fatalf("unsafe parent was not refused: %v: %s", err, output)
		}
	}
	const valid = "Basic ZmFjdG9yeTpzZWNyZXQ="
	initialization["repositoryUrl"] = "https://forge.factory.invalid/owned.git"
	for _, authorization := range []string{
		"Bearer secret", "Authorization: " + valid, "Basic not-base64", "Basic c2VjcmV0",
		valid + "\n", "Basic " + base64.StdEncoding.EncodeToString([]byte("factory:secret\ninjected")),
		"Basic " + strings.Repeat("a", 8192),
	} {
		input, _ := json.Marshal(map[string]any{"root": private, "initialization": initialization, "gitAuthorization": authorization})
		if output, err := sourceInitializeCLI(t, executable, input, 1000, 1000); err == nil ||
			output != "Source initialization Git authorization is invalid" {
			t.Fatalf("invalid authorization was not refused safely: %v: %s", err, output)
		}
	}
	// File repositories need no transport credential, and must not receive one.
	initialization["repositoryUrl"] = "file://" + repository
	input, _ := json.Marshal(map[string]any{"root": private, "initialization": initialization, "gitAuthorization": valid})
	if output, err := sourceInitializeCLI(t, executable, input, 1000, 1000); err == nil ||
		output != "Source initialization Git authorization is invalid" {
		t.Fatalf("file clone accepted an HTTP credential: %v: %s", err, output)
	}
	entries, err := os.ReadDir(private)
	if err != nil || len(entries) != 0 {
		t.Fatal("invalid initialization created private checkout state")
	}
}

func TestSourceInitializeCLIBasicAuthNeverPersistsOrUsesAmbientGitAuthority(t *testing.T) {
	executable, directory := sourceInitializeExecutable(t)
	repository, revision := sourceInitializeRepository(t, directory)
	sourceInitializeGit(t, repository, "update-server-info")
	const secret = "owned-clone-secret"
	authorization := "Basic " + base64.StdEncoding.EncodeToString([]byte("factory:"+secret))
	var mutex sync.Mutex
	var headers []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed := r.Header.Values("Authorization")
		mutex.Lock()
		headers = append(headers, strings.Join(observed, ","))
		mutex.Unlock()
		if len(observed) != 1 || observed[0] != authorization {
			w.Header().Set("WWW-Authenticate", `Basic realm="owned Git"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		http.FileServer(http.Dir(repository)).ServeHTTP(w, r)
	}))
	defer server.Close()
	root := sourceInitializePrivateRoot(t, directory, "private")
	wire := map[string]any{"root": root, "initialization": map[string]string{
		"workspaceId": "owned-workspace", "projectId": "owned-project", "revision": revision,
		"repositoryUrl": server.URL + "/.git", "originUrl": "https://forge.factory.invalid/owned.git",
	}}
	marker := filepath.Join(root, "untrusted-hook-ran")
	hooks := filepath.Join(directory, "hooks")
	if err := os.Mkdir(hooks, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hooks, "post-checkout"), []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	ambient := []string{
		"GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_0=http.extraHeader", "GIT_CONFIG_VALUE_0=Authorization: Basic AMBIENT",
		"GIT_CONFIG_KEY_1=core.hooksPath", "GIT_CONFIG_VALUE_1=" + hooks,
		"GIT_CONFIG_PARAMETERS='core.hooksPath=" + hooks + "'",
	}
	input, _ := json.Marshal(wire)
	if output, err := sourceInitializeCLIEnvironment(t, executable, input, 1000, 1000, ambient); err == nil ||
		strings.Contains(output, secret) || strings.Contains(output, "AMBIENT") {
		t.Fatal("CLI used ambient Git authorization or disclosed transport credentials")
	}
	mutex.Lock()
	observed := append([]string(nil), headers...)
	headers = nil
	mutex.Unlock()
	if len(observed) == 0 {
		t.Fatal("uncredentialed clone never reached owned Git")
	}
	for _, header := range observed {
		if header != "" {
			t.Fatal("ambient Git authorization reached the transport")
		}
	}
	wire["gitAuthorization"] = authorization
	input, _ = json.Marshal(wire)
	if output, err := sourceInitializeCLIEnvironment(t, executable, input, 1000, 1000, ambient); err != nil {
		t.Fatalf("explicit Basic clone failed: %v: %s", err, output)
	}
	mutex.Lock()
	observed = append([]string(nil), headers...)
	headers = nil
	mutex.Unlock()
	if len(observed) == 0 {
		t.Fatal("explicit Basic authorization never reached Git")
	}
	for _, header := range observed {
		if header != authorization {
			t.Fatal("clone authorization was duplicated, changed or absent")
		}
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("initializer ran an inherited hook")
	}
	canonical := filepath.Join(root, "project")
	if got := sourceInitializeGit(t, canonical, "remote", "get-url", "origin"); got != "https://forge.factory.invalid/owned.git" {
		t.Fatal("initializer saved its clone transport as origin")
	}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return err
		}
		data, err := os.ReadFile(path)
		if err == nil && (bytes.Contains(data, []byte(secret)) || bytes.Contains(data, []byte(authorization)) ||
			bytes.Contains(data, []byte(server.URL))) {
			t.Error("initializer persisted clone transport in Source or initialization identity")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// Recovery must neither reclone nor fetch, even if its old credential has expired.
	wire["gitAuthorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte("factory:expired"))
	input, _ = json.Marshal(wire)
	if output, err := sourceInitializeCLI(t, executable, input, 1000, 1000); err != nil {
		t.Fatalf("credential rotation disturbed canonical recovery: %v: %s", err, output)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if len(headers) != 0 {
		t.Fatal("canonical recovery performed another clone transport")
	}
}

func TestSourceInitializeCLIChild(t *testing.T) {
	if os.Getenv("FACTORY_SOURCE_INITIALIZE_CLI_TEST") != "1" {
		t.Skip("owned initializer CLI subprocess")
	}
	os.Args = []string{os.Args[0], "source-initialize"}
	if extra := os.Getenv("FACTORY_SOURCE_INITIALIZE_EXTRA_ARG"); extra != "" {
		os.Args = append(os.Args, extra)
	}
	main()
	os.Exit(0)
}
