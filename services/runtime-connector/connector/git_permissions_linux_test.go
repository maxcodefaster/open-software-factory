package connector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func TestNativeCheckoutRefreshKeepsGitMetadataOwnedByDevelopmentUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	root, err := os.MkdirTemp("", "factory-owned-native-git-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "project")
	if err := os.Mkdir(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	// Match the native initializer, not legacy shared-root Git initialization.
	git := func(arguments ...string) {
		t.Helper()
		if output, err := hardenedGitCommand(context.Background(), workspace, nil, arguments...).CombinedOutput(); err != nil {
			t.Fatalf("owned native Git initialization: %v: %s", err, output)
		}
	}
	git("init", "--initial-branch=main")
	git("config", "user.name", "Owned native Source")
	git("config", "user.email", "owned@example.invalid")
	git("config", "factory.repositoryIdentity", "owned-native-source")
	git("remote", "add", "origin", "https://example.invalid/old.git")
	commitFile(t, workspace, "app.txt", "dirty retained Source\n")
	git("add", "app.txt")
	git("commit", "-m", "Owned native seed")
	if err := filepath.WalkDir(workspace, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(name, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	if err := checkoutProject(context.Background(), Assignment{
		WorkspaceFolder: workspace, PreserveWorkspace: true, RepositoryIdentity: "owned-native-source",
		RepositoryURL: "https://example.invalid/current.git", nativeActorUID: "owned-native-actor",
	}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(filepath.Join(workspace, ".git", "config"))
	if err != nil || info.Sys().(*syscall.Stat_t).Uid != 1000 || info.Sys().(*syscall.Stat_t).Gid != 1000 {
		t.Fatal("native Parent replaced canonical Git metadata with another owner's file")
	}
	origin, err := personalGitCommand(context.Background(), workspace, "remote", "get-url", "origin")
	if err != nil || strings.TrimSpace(origin) != "https://example.invalid/current.git" {
		t.Fatal("native origin was not refreshed")
	}
	base, err := personalGitCommand(context.Background(), workspace, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, workspace, "app.txt", "owned native implementation\n")
	assignment := Assignment{WorkspaceFolder: workspace, nativeActorUID: "owned-native-actor"}
	message := Message{Action: "git-prepare-commit", OperationID: "owned-native-commit", ExpectedSHA: strings.TrimSpace(base), CommitMessage: "Owned native implementation", AuthorName: "Factory", AuthorEmail: "owned@example.invalid"}
	result := handleParentOperation(context.Background(), assignment, message)
	if result.Error != "" || !validCommitSHA(result.CommitSHA) {
		t.Fatalf("native commit was not confirmed: %s", result.Error)
	}
	message.Action = "git-observe-commit"
	if recovered := handleParentOperation(context.Background(), assignment, message); recovered.Error != "" || recovered.CommitSHA != result.CommitSHA {
		t.Fatal("native commit observation did not retain the same exact operation")
	}
	message.Action = "git-prepare-integration"
	message.OperationID = "owned-incomplete-native-integration"
	message.ExpectedSHA = result.CommitSHA
	if refused := handleParentOperation(context.Background(), assignment, message); refused.Error != "integration intent is incomplete" {
		t.Fatal("an incomplete native integration changed retained Source")
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
			t.Errorf("owned native Source metadata changed: %s uid=%d gid=%d mode=%#o", name, stat.Uid, stat.Gid, stat.Mode)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if t.Failed() {
		return
	}
	source, err := workspacefiles.Open(workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	archive, err := os.CreateTemp(root, "source-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if _, err := source.ExportBundle(archive); err != nil {
		t.Fatalf("normal native checkout prevented a complete Source checkpoint: %v", err)
	}
}

func TestParentCommitKeepsCanonicalGitReadable(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	if os.Getenv("FACTORY_GIT_PERMISSIONS_FIXTURE") != "1" {
		// Umask is process-wide. Do not change the ordinary race-test process.
		command := exec.Command(os.Args[0], "-test.run=^TestParentCommitKeepsCanonicalGitReadable$", "-test.v")
		command.Env = append(os.Environ(), "FACTORY_GIT_PERMISSIONS_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("canonical Git permission fixture failed: %v: %s", err, output)
		}
		return
	}
	syscall.Umask(0022)
	root, err := os.MkdirTemp("", "factory-owned-git-permissions-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "project")
	if err := os.Mkdir(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	commitGit(t, workspace, "init", "--initial-branch=main")
	commitGit(t, workspace, "config", "user.name", "Owned source initializer")
	commitGit(t, workspace, "config", "user.email", "owned@factory.local")
	commitGit(t, workspace, "config", "commit.gpgsign", "false")
	commitFile(t, workspace, "app.txt", "base\n")
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "Owned canonical source")
	base := commitGit(t, workspace, "rev-parse", "HEAD")
	commitGit(t, workspace, "checkout", "--detach", base)
	if err := filepath.WalkDir(workspace, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	readAsDeveloper := func(arguments ...string) string {
		t.Helper()
		base := []string{"-c", "safe.directory=" + workspace, "-C", workspace}
		command := exec.Command("git", append(base, arguments...)...)
		command.Env = append(os.Environ(), "HOME="+root, "XDG_CONFIG_HOME="+filepath.Join(root, ".config"), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000}}
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("canonical Git became unreadable to the actual development UID: %v: %s", err, output)
		}
		return string(output)
	}
	readAsDeveloper("status", "--porcelain")
	syscall.Umask(0077)
	commitFile(t, workspace, "app.txt", "implementation\n")
	message := Message{
		Action: "git-prepare-commit", OperationID: "owned-canonical-git-permissions", ExpectedSHA: base,
		CommitMessage: "Owned implementation", AuthorName: "Factory", AuthorEmail: "owned@factory.local",
	}
	commit, err := prepareCommit(context.Background(), workspace, message)
	if err != nil {
		t.Fatal(err)
	}
	readAsDeveloper("rev-parse", "--verify", "HEAD")
	readAsDeveloper("status", "--porcelain")
	if actual := readAsDeveloper("show", "HEAD:app.txt"); actual != "implementation\n" {
		t.Fatalf("canonical committed source differs: %q", actual)
	}
	message.Action = "git-observe-commit"
	if recovered, err := prepareCommit(context.Background(), workspace, message); err != nil || recovered != commit {
		t.Fatalf("same native commit recovery changed identity: %s: %v", recovered, err)
	}
	// A Git-specific fix must not relax unrelated Connector credentials.
	private := filepath.Join(root, "private-runtime-grant")
	if err := os.WriteFile(private, []byte("owned-private-fixture"), 0666); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("the private bootstrap umask changed: %v", err)
	}
}

func TestParentIntegrationKeepsTrackedSourceOwnedByDeveloper(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	if os.Getenv("FACTORY_INTEGRATION_PERMISSIONS_FIXTURE") != "1" {
		child := exec.Command(os.Args[0], "-test.run=^"+t.Name()+"$", "-test.v")
		child.Env = append(os.Environ(), "FACTORY_INTEGRATION_PERMISSIONS_FIXTURE=1")
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("integration ownership fixture failed: %v\n%s", err, output)
		}
		return
	}
	syscall.Umask(0022)
	workspace, message := integrationFixture(t, false)
	if err := os.Chmod(filepath.Dir(workspace), 0755); err != nil {
		t.Fatal(err)
	}
	commitGit(t, workspace, "checkout", "main")
	if err := os.Mkdir(filepath.Join(workspace, "new-source"), 0755); err != nil {
		t.Fatal(err)
	}
	commitFile(t, workspace, "new-source/app.txt", "integrated source\n")
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "New source directory")
	message.MergeParentSHA = commitGit(t, workspace, "rev-parse", "HEAD")
	commitGit(t, workspace, "checkout", message.Branch)
	commitGit(t, workspace, "config", "factory.repositoryIdentity", "owned-integration")
	commitGit(t, workspace, "remote", "add", "origin", message.RepositoryURL)
	if err := filepath.WalkDir(workspace, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(name, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(workspace, ".git", "factory-opencode.db")
	if err := os.WriteFile(private, []byte("private native session"), 0600); err != nil {
		t.Fatal(err)
	}
	syscall.Umask(0077)
	sha, err := prepareCommit(context.Background(), workspace, message)
	if err != nil {
		t.Fatal(err)
	}
	developer := func(script string, arguments ...string) {
		t.Helper()
		child := exec.Command("sh", append([]string{"-ec", script, "owned-source"}, arguments...)...)
		child.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000}}
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("integrated source is unusable by the actual developer: %v\n%s", err, output)
		}
	}
	developer(`test "$(cat "$1")" = "integrated source"; printf "later manual edit\n" > "$1"; printf "new file\n" > "$2"`,
		filepath.Join(workspace, "new-source", "app.txt"), filepath.Join(workspace, "new-source", "manual.txt"))
	for _, name := range []string{"new-source", "new-source/app.txt", "other.txt"} {
		info, err := os.Stat(filepath.Join(workspace, name))
		if err != nil || info.Sys().(*syscall.Stat_t).Uid != 1000 {
			t.Fatalf("Factory left tracked source owned by another user: %s: %v, %v", name, info, err)
		}
	}
	// Reproduce a retained private file written by an older Parent. A normal
	// fresh-start preparation must retain its bytes and the original checkout.
	name := filepath.Join(workspace, "new-source", "app.txt")
	replacement := filepath.Join(workspace, "new-source", "owned-root-replacement")
	if err := os.WriteFile(replacement, []byte("retained manual bytes\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, name); err != nil {
		t.Fatal(err)
	}
	privateDirectory := filepath.Join(workspace, "private-untracked")
	if err := os.Mkdir(privateDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(privateDirectory, "credential"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	message.Action = "git-observe-commit"
	if recovered, err := prepareCommit(context.Background(), workspace, message); err != nil || recovered != sha {
		t.Fatalf("exact commit observation failed: %s, %v", recovered, err)
	}
	if info, err := os.Stat(name); err != nil || info.Sys().(*syscall.Stat_t).Uid != 0 {
		t.Fatal("commit observation changed later file ownership")
	}
	original, err := os.Stat(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkoutProject(context.Background(), Assignment{
		WorkspaceFolder: workspace, PreserveWorkspace: true, RepositoryIdentity: "owned-integration",
		RepositoryURL: message.RepositoryURL, Revision: sha,
	}); err != nil {
		t.Fatal(err)
	}
	developer(`test "$(cat "$1")" = "retained manual bytes"; printf "readable and writable\n" > "$1"`, name)
	if current := commitGit(t, workspace, "rev-parse", "HEAD"); current != sha {
		t.Fatal("ownership preparation changed the exact submitted commit")
	}
	if current, err := os.Stat(workspace); err != nil || !os.SameFile(original, current) {
		t.Fatal("ownership preparation replaced canonical Source")
	}
	if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0600 || info.Sys().(*syscall.Stat_t).Uid != 0 {
		t.Fatal("ownership preparation changed private native Session data")
	}
	if info, err := os.Stat(privateDirectory); err != nil || info.Mode().Perm() != 0700 || info.Sys().(*syscall.Stat_t).Uid != 0 {
		t.Fatal("ownership preparation changed untracked private data")
	}
	grant := filepath.Join(filepath.Dir(workspace), "private-runtime-grant")
	if err := os.WriteFile(grant, []byte("private"), 0666); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(grant); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("integration changed the process-wide private umask")
	}
}

func TestTrackedSourceOwnershipDoesNotFollowPrivateLinkTargets(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	for _, kind := range []string{"symlink", "parent-symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			workspace, _ := commitRepository(t)
			private := filepath.Join(t.TempDir(), "private")
			if err := os.WriteFile(private, []byte("private source fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(workspace, "app.txt")
			if kind == "parent-symlink" {
				if err := os.Mkdir(filepath.Join(workspace, "nested"), 0755); err != nil {
					t.Fatal(err)
				}
				target = filepath.Join(workspace, "nested", "private")
				commitFile(t, workspace, "nested/private", "tracked\n")
				commitGit(t, workspace, "add", "-A")
				if err := os.RemoveAll(filepath.Dir(target)); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Dir(private), filepath.Dir(target)); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Remove(target); err != nil {
					t.Fatal(err)
				}
				link := os.Symlink
				if kind == "hardlink" {
					link = os.Link
				}
				if err := link(private, target); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Chown(workspace, 1000, 1000); err != nil {
				t.Fatal(err)
			}
			err := ensureTrackedWorkspaceOwnership(context.Background(), workspace)
			if (kind == "hardlink") != (err != nil) {
				t.Fatalf("unexpected protected tracked-source result: %v", err)
			}
			if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0600 || info.Sys().(*syscall.Stat_t).Uid != 0 {
				t.Fatal("tracked Source ownership widened a private link target")
			}
		})
	}
}

func TestCanonicalGitPreparationRestoresReadabilityWithoutReset(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires the owned root Linux Connector fixture")
	}
	root, err := os.MkdirTemp("", "factory-owned-existing-git-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "project")
	if err := os.Mkdir(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	commitGit(t, workspace, "init", "--initial-branch=main")
	commitGit(t, workspace, "config", "user.name", "Owned canonical source")
	commitGit(t, workspace, "config", "user.email", "owned@factory.local")
	commitGit(t, workspace, "config", "commit.gpgsign", "false")
	commitGit(t, workspace, "config", "factory.repositoryIdentity", "owned-project")
	commitGit(t, workspace, "remote", "add", "origin", "https://example.invalid/owned.git")
	commitFile(t, workspace, "app.txt", "retained source\n")
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "Owned source")
	head := commitGit(t, workspace, "rev-parse", "HEAD")
	commitGit(t, workspace, "checkout", "--detach", head)
	if err := filepath.WalkDir(workspace, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(workspace, ".git")
	headPath := filepath.Join(metadata, "HEAD")
	content, err := os.ReadFile(headPath)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(metadata, "owned-private-HEAD")
	if err := os.WriteFile(replacement, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, headPath); err != nil {
		t.Fatal(err)
	}
	objectDirectory := filepath.Join(metadata, "objects", head[:2])
	object := filepath.Join(objectDirectory, head[2:])
	if err := os.Chown(objectDirectory, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(objectDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(object, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(object, 0400); err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(metadata, "factory-opencode.db")
	if err := os.WriteFile(private, []byte("owned-private-session-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	commitFile(t, workspace, "app.txt", "retained uncommitted edit\n")
	original, err := os.Stat(workspace)
	if err != nil {
		t.Fatal(err)
	}
	read := func() ([]byte, error) {
		command := exec.Command("git", "-c", "safe.directory="+workspace, "-C", workspace, "status", "--porcelain")
		command.Env = append(os.Environ(), "HOME="+root, "XDG_CONFIG_HOME="+filepath.Join(root, ".config"), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000}}
		return command.CombinedOutput()
	}
	if _, err := read(); err == nil {
		t.Fatal("the historical root-private HEAD must reproduce the real development failure")
	}
	assignment := Assignment{
		WorkspaceFolder: workspace, PreserveWorkspace: true, RepositoryIdentity: "owned-project",
		RepositoryURL: "https://example.invalid/owned.git", Revision: head,
	}
	if err := checkoutProject(context.Background(), assignment); err != nil {
		t.Fatal(err)
	}
	if output, err := read(); err != nil || string(output) != " M app.txt\n" {
		t.Fatalf("canonical startup did not restore Git reads while preserving manual work: %v: %s", err, output)
	}
	if current := commitGit(t, workspace, "rev-parse", "HEAD"); current != head {
		t.Fatal("canonical preparation changed the exact retained HEAD")
	}
	if after, err := os.Stat(workspace); err != nil || !os.SameFile(original, after) {
		t.Fatal("canonical Source directory identity changed")
	}
	if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("private OpenCode history permissions changed")
	}
}

func TestCanonicalGitReadabilityRejectsPrivateLinkTargets(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			workspace, _ := commitRepository(t)
			commitGit(t, workspace, "config", "factory.repositoryIdentity", "owned-project")
			commitGit(t, workspace, "remote", "add", "origin", "https://example.invalid/owned.git")
			private := filepath.Join(t.TempDir(), "private-runtime-grant")
			if err := os.WriteFile(private, []byte("owned-private-fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(workspace, ".git", "objects", "ff")
			if err := os.MkdirAll(directory, 0755); err != nil {
				t.Fatal(err)
			}
			link := os.Link
			if kind == "symlink" {
				link = os.Symlink
			}
			if err := link(private, filepath.Join(directory, "owned-private-link")); err != nil {
				t.Fatal(err)
			}
			assignment := Assignment{
				WorkspaceFolder: workspace, PreserveWorkspace: true, RepositoryIdentity: "owned-project",
				RepositoryURL: "https://example.invalid/owned.git",
			}
			if err := checkoutProject(context.Background(), assignment); err == nil {
				t.Fatal("canonical preparation admitted a link to private data")
			}
			if info, err := os.Stat(private); err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("canonical preparation widened private link target permissions")
			}
		})
	}
}
