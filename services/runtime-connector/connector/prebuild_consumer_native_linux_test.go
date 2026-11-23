package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func nativePrebuildConsumerRepository(t *testing.T) (Assignment, string) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	root, err := os.MkdirTemp("", "factory-native-prebuild-consumer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "project")
	if err := os.MkdirAll(filepath.Join(workspace, ".devcontainer"), 0755); err != nil {
		t.Fatal(err)
	}
	config := `{"image":"docker.io/library/node@sha256:` + strings.Repeat("a", 64) + `","remoteUser":"node"}`
	for name, content := range map[string]string{
		".devcontainer/devcontainer.json": config,
		"app.txt":                         "unchanged tracked source\n",
	} {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{
		{"init", "--initial-branch=main"},
		{"config", "factory.repositoryIdentity", "owned-native-consumer"},
		{"add", "."},
		{"-c", "user.name=Owned", "-c", "user.email=owned@example.invalid", "commit", "-m", "owned seed"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", workspace}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("owned repository setup: %v: %s", err, out)
		}
	}
	commit, err := exec.Command("git", "-C", workspace, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	if err := filepath.WalkDir(workspace, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(name, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	// Refreshing an otherwise unchanged tracked file is the real `git status`
	// pattern that can replace its development-owned index from the Parent.
	stamp := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(filepath.Join(workspace, "app.txt"), stamp, stamp); err != nil {
		t.Fatal(err)
	}
	assignment := Assignment{
		WorkspaceFolder: workspace, ConnectorStateDir: filepath.Join(root, "connector"),
		RepositoryIdentity: "owned-native-consumer", Revision: strings.TrimSpace(string(commit)),
		DevcontainerPath: ".devcontainer/devcontainer.json",
		nativeActorUID:   "86ba05ce-4939-4215-bf45-f1874ff4112a",
	}
	fixturePrebuildTools(t, filepath.Join(root, "opencode-tools"))
	t.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", assignment.nativeActorUID)
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	t.Setenv("DOCKER_HOST", "unix:///run/user/1000/docker.sock")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:8888")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:8888")
	return assignment, root
}

func TestNativePrebuildColdAcquisitionIsNotCancelledByMetadataLookupDeadline(t *testing.T) {
	assignment, root := nativePrebuildConsumerRepository(t)
	ctx := fixturePrebuildToolsContext(t.Context(), assignment)
	version := uint64(2)
	assignment.EnvironmentVersion = &version
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		t.Fatal(err)
	}
	identityFile := filepath.Join(root, "input-identity")
	readyFile := filepath.Join(root, "pulled")
	pulls := filepath.Join(root, "pulls")
	delayFile := filepath.Join(root, "pull-delay")
	trace := filepath.Join(root, "docker-trace")
	if err := os.WriteFile(delayFile, []byte("31"), 0644); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
printf '%s %s\n' "$DOCKER_HOST" "$*" >>'` + trace + `'
test "$DOCKER_HOST" = unix:///run/user/1000/docker.sock || exit 9
case "$1 $2" in
  "info --format") printf 'linux/aarch64' ;;
  "image inspect")
    test -f '` + readyFile + `' || exit 1
    if [ "$4" = '{{json .RepoDigests}}' ]; then printf '["%s"]' "$5"
    else printf '[{"Id":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Os":"linux","Architecture":"arm64","Config":{"Labels":{"factory.dev/prebuild-input":"%s"}}}]' "$(cat '` + identityFile + `')"; fi ;;
  "pull "*) printf 'pull\n' >>'` + pulls + `'; : >'` + readyFile + `'; exec sleep "$(cat '` + delayFile + `')" ;;
  *) exit 8 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	config := `{"image":"docker.io/library/node@sha256:` + strings.Repeat("a", 64) + `","remoteUser":"node"}`
	cli := "#!/bin/sh\nprintf '%s\\n' '{\"configuration\":" + config + "}'\n"
	if err := os.WriteFile(filepath.Join(bin, "devcontainer"), []byte(cli), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NO_PROXY", "localhost,127.0.0.1")
	t.Setenv("no_proxy", "localhost,127.0.0.1")
	repository := "registry.factory/prebuilds/" + assignment.RepositoryIdentity
	input, snapshot, err := preparePrebuildInputWith(ctx, assignment,
		PrebuildRequest{Commit: assignment.Revision, Platform: "linux/arm64", ImageRepository: repository}, readPrebuildConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Dir(snapshot))
	identity := prebuildIdentity(input)
	if err := os.WriteFile(identityFile, []byte(identity), 0644); err != nil {
		t.Fatal(err)
	}
	image := repository + "@sha256:" + strings.Repeat("c", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/project-image/"+assignment.RuntimeAttemptID ||
			request.Header.Get("Authorization") != "Bearer owned-consumer-token" ||
			request.Header.Get("X-Factory-Runtime-Generation") != "1" {
			t.Error("metadata request lost its original authenticated identity")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		json.NewEncoder(w).Encode(PrebuildResult{Identity: identity, Image: image})
	}))
	defer server.Close()
	assignment.RuntimeAttemptID = "owned-cold-consumer"
	assignment.Generation = 1
	assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
	selected := compatibleRuntimePrebuild(ctx, assignment, "owned-consumer-token")
	if selected != image {
		out, _ := os.ReadFile(trace)
		t.Fatalf("a cold pull longer than the metadata window discarded the verified image: %q\n%s", selected, out)
	}
	out, err := os.ReadFile(pulls)
	if err != nil || string(out) != "pull\n" {
		t.Fatal("cold acquisition was repeated")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if selected := compatibleRuntimePrebuild(cancelled, assignment, "owned-consumer-token"); selected != "" {
		t.Fatal("cancelled caller was ignored during cache selection")
	}
	if err := os.Remove(readyFile); err != nil {
		t.Fatal(err)
	}
	// Separately cancel after the real acquisition entry, without assuming
	// metadata/Git scheduling fits into the short caller deadline above.
	acquiring, cancelAcquiring := context.WithCancel(ctx)
	defer cancelAcquiring()
	entered := make(chan bool, 1)
	go func() {
		until := time.Now().Add(5 * time.Second)
		for time.Now().Before(until) {
			if _, err := os.Stat(readyFile); err == nil {
				cancelAcquiring()
				entered <- true
				return
			}
			time.Sleep(time.Millisecond)
		}
		cancelAcquiring()
		entered <- false
	}()
	if selected := compatibleRuntimePrebuild(acquiring, assignment, "owned-consumer-token"); selected != "" {
		t.Fatal("caller cancellation was ignored during acquisition")
	}
	if !<-entered || acquiring.Err() != context.Canceled {
		t.Fatal("the acquisition cancellation scenario did not run")
	}
	if err := os.Remove(readyFile); err != nil {
		t.Fatal(err)
	}
	// A shorter explicit caller deadline still bounds the complete selection.
	// On a busy host it can expire before Docker starts.
	bounded, cancelBounded := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancelBounded()
	if selected := compatibleRuntimePrebuild(bounded, assignment, "owned-consumer-token"); selected != "" {
		t.Fatal("shorter caller deadline was ignored during cold acquisition")
	}
	if bounded.Err() != context.DeadlineExceeded {
		t.Fatal("the bounded caller did not reach its explicit deadline")
	}
	if err := os.Remove(readyFile); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.WriteFile(delayFile, []byte("0.2"), 0644); err != nil {
		t.Fatal(err)
	}
	changed := make(chan error, 1)
	go func() {
		until := time.Now().Add(5 * time.Second)
		for time.Now().Before(until) {
			if _, err := os.Stat(readyFile); err == nil {
				changed <- os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "app.txt"), []byte("new content during acquisition\n"), 0644)
				return
			}
			time.Sleep(time.Millisecond)
		}
		changed <- os.ErrDeadlineExceeded
	}()
	if selected := compatibleRuntimePrebuild(ctx, assignment, "owned-consumer-token"); selected != "" {
		t.Fatal("Source changed during acquisition but the old prebuild was selected")
	}
	if err := <-changed; err != nil {
		t.Fatal("the source-change scenario did not run", err)
	}
}

func TestNativePrebuildGitKeepsDevelopmentIndexOwnership(t *testing.T) {
	assignment, _ := nativePrebuildConsumerRepository(t)
	ctx, err := nativePrebuildContext(fixturePrebuildToolsContext(t.Context(), assignment), assignment)
	if err != nil {
		t.Fatal(err)
	}
	out, err := prebuildSourceGit(ctx, assignment.WorkspaceFolder, "status", "--porcelain")
	if err != nil || out != "" {
		t.Fatalf("native clean Source read failed: %v: %s", err, out)
	}
	info, err := os.Lstat(filepath.Join(assignment.WorkspaceFolder, ".git/index"))
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if stat.Uid != 1000 || stat.Gid != 1000 {
		t.Fatalf("prebuild Git changed development index ownership to %d:%d", stat.Uid, stat.Gid)
	}
}

func TestNativePrebuildConsumerConfigurationRetainsPrivateTransport(t *testing.T) {
	assignment, root := nativePrebuildConsumerRepository(t)
	ctx := fixturePrebuildToolsContext(t.Context(), assignment)
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		t.Fatal(err)
	}
	config := `{"image":"docker.io/library/node@sha256:` + strings.Repeat("a", 64) + `","remoteUser":"node"}`
	trace := filepath.Join(root, "consumer-config-trace")
	cli := `#!/bin/sh
printf '%s %s\n' "$DOCKER_HOST" "$HTTP_PROXY" >>'` + trace + `'
test "$DOCKER_HOST" = unix:///run/user/1000/docker.sock || exit 9
test "$HTTP_PROXY" = http://127.0.0.1:8888 || exit 8
printf '%s\n' '{"configuration":` + config + `}'
`
	if err := os.WriteFile(filepath.Join(bin, "devcontainer"), []byte(cli), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nprintf '%s' '{\"devcontainer.metadata\":\"[]\"}'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	image := "registry.factory/prebuilds/" + assignment.RepositoryIdentity + "@sha256:" + strings.Repeat("c", 64)
	path, cleanup, err := preparePrebuildConsumer(ctx, assignment, image)
	defer cleanup()
	if err != nil {
		out, _ := os.ReadFile(trace)
		t.Fatalf("native consumer configuration lost the private Docker connection: %v\n%s", err, out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var generated map[string]json.RawMessage
	if json.Unmarshal(data, &generated) != nil || string(generated["image"]) != `"`+image+`"` {
		t.Fatal("verified prepared image was not selected in the consumer configuration")
	}
	original, err := os.ReadFile(filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath))
	if err != nil || string(original) != config {
		t.Fatal("consumer rewrote canonical Source configuration")
	}
}

func TestNativePrebuildConsumerRetainsPrivateDockerContextThroughImageInspection(t *testing.T) {
	assignment, root := nativePrebuildConsumerRepository(t)
	ctx := fixturePrebuildToolsContext(t.Context(), assignment)
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0755); err != nil {
		t.Fatal(err)
	}
	trace := filepath.Join(root, "docker-trace")
	identityFile := filepath.Join(root, "input-identity")
	script := `#!/bin/sh
printf '%s %s\n' "$DOCKER_HOST" "$*" >>'` + trace + `'
test "$DOCKER_HOST" = unix:///run/user/1000/docker.sock || exit 9
case "$1 $2" in
  "info --format") printf 'linux/aarch64' ;;
  "image inspect")
    if [ "$4" = '{{json .RepoDigests}}' ]; then printf '["%s"]' "$5"
    else printf '[{"Id":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Os":"linux","Architecture":"arm64","Config":{"Labels":{"factory.dev/prebuild-input":"%s"}}}]' "$(cat '` + identityFile + `')"; fi ;;
  "image pull") exit 0 ;;
  *) exit 8 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	read := func(context.Context, string, string) (prebuildConfiguration, error) {
		return prebuildConfiguration{
			Image:    "docker.io/library/node@sha256:" + strings.Repeat("a", 64),
			Document: json.RawMessage(`{"image":"docker.io/library/node@sha256:` + strings.Repeat("a", 64) + `","remoteUser":"node"}`),
		}, nil
	}
	repository := "registry.factory/prebuilds/" + assignment.RepositoryIdentity
	input, snapshot, err := preparePrebuildInputWith(ctx, assignment,
		PrebuildRequest{Commit: assignment.Revision, Platform: "linux/arm64", ImageRepository: repository}, read)
	if err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Dir(snapshot))
	identity := prebuildIdentity(input)
	if err := os.WriteFile(identityFile, []byte(identity), 0644); err != nil {
		t.Fatal(err)
	}
	image := repository + "@sha256:" + strings.Repeat("c", 64)
	got := compatiblePrebuild(ctx, assignment, PrebuildResult{Identity: identity, Image: image}, read)
	if got != image {
		out, _ := os.ReadFile(trace)
		t.Fatalf("native compatible image was discarded after acquisition: selected=%q; Docker calls:\n%s", got, out)
	}
	out, _ := os.ReadFile(trace)
	if strings.Contains(string(out), "/var/run/docker.sock") {
		t.Fatal("native image inspection used an unassigned Docker socket")
	}
	if err := os.WriteFile(identityFile, []byte(strings.Repeat("d", 64)), 0644); err != nil {
		t.Fatal(err)
	}
	if selected := compatiblePrebuild(ctx, assignment, PrebuildResult{Identity: identity, Image: image}, read); selected != "" {
		t.Fatal("a foreign image input label was admitted")
	}
	if err := os.WriteFile(identityFile, []byte(identity), 0644); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(trace)
	changed := assignment
	changed.nativeActorUID = "dcd0586c-54bf-410d-9f30-2cc7af4dfbc6"
	if selected := compatiblePrebuild(ctx, changed, PrebuildResult{Identity: identity, Image: image}, read); selected != "" {
		t.Fatal("changed native Actor authority selected an image")
	}
	after, _ := os.ReadFile(trace)
	if string(before) != string(after) {
		t.Fatal("changed native authority reached Docker")
	}
	if err := os.WriteFile(filepath.Join(assignment.WorkspaceFolder, "app.txt"), []byte("unsaved new Source\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if selected := compatiblePrebuild(ctx, assignment, PrebuildResult{Identity: identity, Image: image}, read); selected != "" {
		t.Fatal("a dirty retained checkout selected its old prebuild")
	}
	after, _ = os.ReadFile(trace)
	if string(before) != string(after) {
		t.Fatal("dirty Source reached Docker")
	}
}
