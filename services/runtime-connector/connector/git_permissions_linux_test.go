package connector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

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
