package workspacefiles

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func initializerFixture(t *testing.T) (string, Initialization) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("native initializer ownership requires the trusted initializer UID")
	}
	parent := t.TempDir()
	repository := t.TempDir()
	ctx := context.Background()
	for _, args := range [][]string{{"init", "--initial-branch=main"}, {"config", "user.name", "Fixture"}, {"config", "user.email", "fixture@factory.invalid"}} {
		if _, err := initGit(ctx, repository, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(repository, "source.txt"), []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "source.txt"}, {"commit", "-m", "Source fixture"}} {
		if _, err := initGit(ctx, repository, args...); err != nil {
			t.Fatal(err)
		}
	}
	revision, err := initGit(ctx, repository, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return parent, Initialization{WorkspaceID: "workspace-a", ProjectID: "project-a", Revision: revision, RepositoryURL: "file://" + repository, OriginURL: "https://forge.factory.invalid/project.git"}
}

func TestSourceInitializationPublishesOnceAndRetainsHumanWork(t *testing.T) {
	parent, intent := initializerFixture(t)
	ctx := context.Background()
	if err := Initialize(ctx, parent, intent); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(parent, "project")
	var info unix.Stat_t
	if err := unix.Stat(canonical, &info); err != nil || info.Uid != 101000 || info.Gid != 101000 {
		t.Fatalf("incorrect mapped source owner: %v %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(canonical, "source.txt"), []byte("human edit"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := Initialize(ctx, parent, intent); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(filepath.Join(canonical, "source.txt"))
	if string(content) != "human edit" {
		t.Fatal("recovery overwrote human work")
	}
	origin, err := initGit(ctx, canonical, "remote", "get-url", "origin")
	if err != nil || origin != intent.OriginURL {
		t.Fatal("initializer retained a capability or clone URL")
	}
	if err := filepath.WalkDir(filepath.Join(canonical, ".git"), func(name string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		content, err := os.ReadFile(name)
		if err == nil && strings.Contains(string(content), intent.RepositoryURL) {
			t.Errorf("clone-only URL leaked into Git metadata: %s", name)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	intent.ProjectID = "another-project"
	if err := Initialize(ctx, parent, intent); err == nil {
		t.Fatal("initializer adopted unrelated source")
	}
}

func TestPersonalSourceStartsOnANamedBranchWithoutChangingTicketInitialization(t *testing.T) {
	parent, intent := initializerFixture(t)
	intent.Branch = "main"
	if err := Initialize(context.Background(), parent, intent); err != nil {
		t.Fatal(err)
	}
	branch, err := initGit(context.Background(), filepath.Join(parent, "project"), "symbolic-ref", "--short", "HEAD")
	if err != nil || branch != intent.Branch {
		t.Fatalf("personal source is not on its named branch: %q %v", branch, err)
	}
	upstream, err := initGit(context.Background(), filepath.Join(parent, "project"), "rev-parse", "--abbrev-ref", "@{upstream}")
	if err != nil || upstream != "origin/main" {
		t.Fatalf("personal source lacks its normal upstream: %q %v", upstream, err)
	}
}

func TestSourceInitializationRecoversRetainedCheckoutThroughLinuxHost(t *testing.T) {
	parent, intent := initializerFixture(t)
	ctx := context.Background()
	if err := Initialize(ctx, parent, intent); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(parent, "project")
	if err := os.WriteFile(filepath.Join(canonical, "source.txt"), []byte("retained candidate"), 0644); err != nil {
		t.Fatal(err)
	}
	intent.RepositoryURL = "http://192.168.139.2:3000/internal/workspace-source/owned-capability"
	intent.OriginURL = "http://192.168.139.2:3001/factory/project.git"
	if err := Initialize(ctx, parent, intent); err != nil {
		t.Fatal("Linux callback address prevented retained source recovery:", err)
	}
	content, err := os.ReadFile(filepath.Join(canonical, "source.txt"))
	if err != nil || string(content) != "retained candidate" {
		t.Fatal("recovery changed retained candidate", err)
	}
}

func TestSourceRepositoryURLAllowsPrivateLinuxEndpointsOnly(t *testing.T) {
	for _, value := range []string{
		"http://192.168.139.2:3000/source",
		"http://10.0.0.2:3000/source",
		"http://172.20.0.2:3000/source",
		"http://127.0.0.1:3000/source",
		"http://[fd00::2]:3000/source",
	} {
		if !sourceRepositoryURL(value) {
			t.Fatalf("local Linux source endpoint rejected: %q", value)
		}
	}
	for _, value := range []string{
		"http://8.8.8.8/source",
		"http://example.com/source",
		"http://169.254.169.254/source",
		"http://0.0.0.0/source",
		"http://[::]/source",
		"http://[ff02::1]/source",
		"http://secret@192.168.139.2/source",
		"http://192.168.139.2/\nsource",
	} {
		if sourceRepositoryURL(value) {
			t.Fatalf("unsafe source endpoint admitted: %q", value)
		}
	}
}

func TestSourceInitializationRecoversOnlyItsPrivatePartialClone(t *testing.T) {
	parent, intent := initializerFixture(t)
	intent.Revision = strings.Repeat("a", 40)
	if err := Initialize(context.Background(), parent, intent); err == nil {
		t.Fatal("missing revision succeeded")
	}
	if _, err := os.Stat(filepath.Join(parent, "project")); !os.IsNotExist(err) {
		t.Fatal("partial source became canonical")
	}
	if err := Initialize(context.Background(), parent, intent); err == nil {
		t.Fatal("partial clone recovery invented a revision")
	}
	// A new access epoch may use a different clone capability for the same intended checkout.
	intent.RepositoryURL += "/unused"
	if err := Initialize(context.Background(), parent, intent); err == nil || strings.Contains(err.Error(), "staging identity") {
		t.Fatal("a changed clone-only capability blocked owned staging recovery", err)
	}
	intent.ProjectID = "other-project"
	if err := Initialize(context.Background(), parent, intent); err == nil {
		t.Fatal("foreign staging was adopted")
	}
}

func TestSourceInitializationLockCannotFollowLinksAndHonorsCancellation(t *testing.T) {
	parent, intent := initializerFixture(t)
	lockPath := filepath.Join(parent, ".factory-source-init-lock")
	if err := os.Symlink(filepath.Join(t.TempDir(), "foreign"), lockPath); err != nil {
		t.Fatal(err)
	}
	if err := Initialize(context.Background(), parent, intent); err == nil {
		t.Fatal("initialization followed a lock symlink")
	}
	if err := os.Remove(lockPath); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Initialize(ctx, parent, intent); err != context.Canceled {
		t.Fatal("locked initializer ignored cancellation", err)
	}
}

func TestCanceledSourceInitializationDoesNotCreateWork(t *testing.T) {
	parent, intent := initializerFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Initialize(ctx, parent, intent); err != context.Canceled {
		t.Fatal("canceled initialization did not stop", err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("canceled initialization created checkout state", entries, err)
	}
}

func TestSourceInitializationRejectsLinkAndExecutableCloneProtocols(t *testing.T) {
	parent, intent := initializerFixture(t)
	if err := os.Symlink(t.TempDir(), filepath.Join(parent, "project")); err != nil {
		t.Fatal(err)
	}
	if err := Initialize(context.Background(), parent, intent); err == nil {
		t.Fatal("canonical symlink was adopted")
	}
	for _, value := range []string{"ext::touch /tmp/bypass", "ssh://forge.factory.invalid/project", "https://secret@forge.factory.invalid/project", "https://forge.factory.invalid/\nproject"} {
		if sourceRepositoryURL(value) {
			t.Fatalf("unsafe source clone protocol admitted: %q", value)
		}
	}
}
