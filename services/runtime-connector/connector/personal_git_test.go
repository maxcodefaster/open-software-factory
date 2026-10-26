package connector

import (
	"context"
	"encoding/json"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func personalRepository(t *testing.T) (Assignment, string) {
	t.Helper()
	root, err := os.MkdirTemp("", "factory-personal-git-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	for _, args := range [][]string{
		{"init", "--initial-branch=main"}, {"config", "user.name", "Personal fixture"},
		{"config", "user.email", "personal@factory.invalid"},
	} {
		commitGit(t, root, args...)
	}
	commitFile(t, root, "app.txt", "initial\n")
	commitGit(t, root, "add", "-A")
	commitGit(t, root, "-c", "commit.gpgsign=false", "commit", "-m", "Initial")
	if os.Geteuid() == 0 {
		if err := filepath.WalkDir(root, func(path string, _ os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			return os.Lchown(path, 1000, 1000)
		}); err != nil {
			t.Fatal(err)
		}
	}
	return Assignment{WorkspaceFolder: root, PreserveWorkspace: true}, commitGit(t, root, "rev-parse", "HEAD")
}

func callPersonalGit(t *testing.T, assignment Assignment, input personalGitRequest) (string, error) {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return personalGit(context.Background(), assignment, Message{
		OperationID: "11111111-1111-4111-8111-111111111111", Data: string(data),
	})
}

func TestPersonalGitStatusDiffAndCommitPreserveSource(t *testing.T) {
	assignment, initial := personalRepository(t)
	commitFile(t, assignment.WorkspaceFolder, "app.txt", "human edit\n")
	commitFile(t, assignment.WorkspaceFolder, "new.txt", "new human file\n")
	if os.Geteuid() == 0 {
		_ = os.Chown(filepath.Join(assignment.WorkspaceFolder, "new.txt"), 1000, 1000)
	}
	result, err := callPersonalGit(t, assignment, personalGitRequest{Action: "status", Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	var status personalGitStatus
	if json.Unmarshal([]byte(result), &status) != nil || status.Head != initial || status.Branch != "main" || len(status.Files) != 2 {
		t.Fatalf("invalid status: %s", result)
	}
	for _, path := range []string{"app.txt", "new.txt"} {
		diff, err := callPersonalGit(t, assignment, personalGitRequest{Action: "diff", Branch: "main", Path: path})
		if err != nil || !strings.Contains(diff, "human") {
			t.Fatalf("diff missing authored content: %s, %v", diff, err)
		}
	}
	hook := filepath.Join(assignment.WorkspaceFolder, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	result, err = callPersonalGit(t, assignment, personalGitRequest{
		Action: "commit", Branch: "main", ExpectedHead: initial, Message: "Saved personal work",
		AuthorName: "Personal Developer", AuthorEmail: "developer@factory.invalid",
	})
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(result), &status) != nil || status.Head == initial || len(status.Files) != 0 {
		t.Fatalf("commit did not preserve its resulting identity: %s", result)
	}
	if body := commitGit(t, assignment.WorkspaceFolder, "show", "-s", "--format=%B", "HEAD"); !strings.Contains(body, "Factory-Operation: 11111111-1111-4111-8111-111111111111") {
		t.Fatal("commit lost operation identity")
	}
	if count := commitGit(t, assignment.WorkspaceFolder, "rev-list", "--count", "HEAD"); count != "2" {
		t.Fatal("unexpected commit count")
	}
}

func TestPersonalGitRejectsStaleDirtyDetachedAndUnsafeRequests(t *testing.T) {
	assignment, initial := personalRepository(t)
	commitFile(t, assignment.WorkspaceFolder, "app.txt", "retained edit\n")
	cases := []personalGitRequest{
		{Action: "pull", Branch: "main", ExpectedHead: initial},
		{Action: "commit", Branch: "main", ExpectedHead: strings.Repeat("a", 40), Message: "Wrong HEAD"},
		{Action: "diff", Branch: "main", Path: "../outside"},
		{Action: "diff", Branch: "main", Path: ".git/config"},
		{Action: "diff", Branch: "main", Path: "src/../../outside"},
		{Action: "status", Branch: "main; touch /tmp/no"},
		{Action: "push", Branch: "main", ExpectedHead: initial},
	}
	for _, input := range cases {
		if _, err := callPersonalGit(t, assignment, input); err == nil {
			t.Fatalf("unsafe operation admitted: %+v", input)
		}
		if head := commitGit(t, assignment.WorkspaceFolder, "rev-parse", "HEAD"); head != initial {
			t.Fatal("rejected command changed HEAD")
		}
	}
	commitGit(t, assignment.WorkspaceFolder, "checkout", "--detach", initial)
	if _, err := callPersonalGit(t, assignment, personalGitRequest{Action: "commit", Branch: "main", ExpectedHead: initial, Message: "Detached"}); err == nil {
		t.Fatal("detached mutation was admitted")
	}
	assignment.PreserveWorkspace = false
	if _, err := callPersonalGit(t, assignment, personalGitRequest{Action: "status", Branch: "main"}); err == nil {
		t.Fatal("isolated execution was admitted")
	}
}

func TestPersonalGitFetchAndPullUseScopedHTTPWithoutOverwritingLocalCommits(t *testing.T) {
	assignment, initial := personalRepository(t)
	serverRoot := t.TempDir()
	bare := filepath.Join(serverRoot, "repository.git")
	commitGit(t, assignment.WorkspaceFolder, "init", "--bare", bare)
	commitGit(t, bare, "symbolic-ref", "HEAD", "refs/heads/main")
	commitGit(t, assignment.WorkspaceFolder, "push", bare, "HEAD:refs/heads/main")
	remote := filepath.Join(serverRoot, "writer")
	commitGit(t, assignment.WorkspaceFolder, "clone", "--", bare, remote)
	for _, args := range [][]string{{"config", "user.name", "Remote fixture"}, {"config", "user.email", "remote@factory.invalid"}} {
		commitGit(t, remote, args...)
	}
	commitFile(t, remote, "remote.txt", "remote work\n")
	commitGit(t, remote, "add", "-A")
	commitGit(t, remote, "-c", "commit.gpgsign=false", "commit", "-m", "Remote work")
	commitGit(t, remote, "push", "origin", "main")
	remoteHead := commitGit(t, remote, "rev-parse", "HEAD")
	gitBinary, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(&cgi.Handler{
		Path: gitBinary, Args: []string{"http-backend"},
		Env: []string{"GIT_PROJECT_ROOT=" + serverRoot, "GIT_HTTP_EXPORT_ALL=1"},
	})
	defer server.Close()
	repository := server.URL + "/repository.git"
	result, err := callPersonalGit(t, assignment, personalGitRequest{
		Action: "fetch", Branch: "main", ExpectedHead: initial, Repository: repository,
	})
	if err != nil {
		t.Fatal(err)
	}
	var status personalGitStatus
	if json.Unmarshal([]byte(result), &status) != nil || status.Head != initial {
		t.Fatal("Fetch changed the personal checkout")
	}
	if err := filepath.WalkDir(filepath.Join(assignment.WorkspaceFolder, ".git"), func(path string, entry os.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return err
		}
		content, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(content), repository) {
			t.Errorf("scoped fetch URL leaked into retained Git metadata: %s", path)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	result, err = callPersonalGit(t, assignment, personalGitRequest{
		Action: "pull", Branch: "main", ExpectedHead: initial, Repository: repository,
	})
	if err != nil || json.Unmarshal([]byte(result), &status) != nil || status.Head != remoteHead {
		t.Fatalf("Pull did not fast-forward to fetched main: %s %v", result, err)
	}
	commitFile(t, assignment.WorkspaceFolder, "app.txt", "personal commit\n")
	if _, err := callPersonalGit(t, assignment, personalGitRequest{
		Action: "commit", Branch: "main", ExpectedHead: remoteHead, Message: "Personal commit",
		AuthorName: "Developer", AuthorEmail: "developer@factory.invalid",
	}); err != nil {
		t.Fatal(err)
	}
	localHead := commitGit(t, assignment.WorkspaceFolder, "rev-parse", "HEAD")
	commitFile(t, remote, "remote.txt", "more remote work\n")
	commitGit(t, remote, "add", "-A")
	commitGit(t, remote, "-c", "commit.gpgsign=false", "commit", "-m", "More remote work")
	commitGit(t, remote, "push", "origin", "main")
	if _, err := callPersonalGit(t, assignment, personalGitRequest{
		Action: "pull", Branch: "main", ExpectedHead: localHead, Repository: repository,
	}); err == nil || !strings.Contains(err.Error(), "Cannot fast-forward") {
		t.Fatalf("diverged history was not rejected: %v", err)
	}
	if head := commitGit(t, assignment.WorkspaceFolder, "rev-parse", "HEAD"); head != localHead {
		t.Fatal("Pull changed local commits")
	}
}
