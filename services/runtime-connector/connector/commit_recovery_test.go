package connector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func commitGit(t *testing.T, workspace string, arguments ...string) string {
	t.Helper()
	output, err := gitOutput(context.Background(), workspace, arguments...)
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func commitFile(t *testing.T, workspace, name, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(workspace, name), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func commitRepository(t *testing.T) (string, Message) {
	t.Helper()
	workspace := t.TempDir()
	commitGit(t, workspace, "init", "--initial-branch=main")
	commitGit(t, workspace, "config", "user.name", "Owned Git fixture")
	commitGit(t, workspace, "config", "user.email", "owned@factory.local")
	commitGit(t, workspace, "config", "commit.gpgsign", "false")
	commitFile(t, workspace, "app.txt", "base\n")
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "Owned base")
	return workspace, Message{
		OperationID: "owned-operation", ExpectedSHA: commitGit(t, workspace, "rev-parse", "HEAD"),
		CommitMessage: "Owned implementation", AuthorName: "Open Software Factory", AuthorEmail: "factory@localhost",
		Branch: "factory/owned-change",
	}
}

func TestPrepareCommitRecoveryPreservesManualFiles(t *testing.T) {
	workspace, message := commitRepository(t)
	commitFile(t, workspace, "app.txt", "implementation\n")
	first, err := prepareCommit(context.Background(), workspace, message)
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, workspace, "manual.txt", "manual work after the lost response\n")
	commitFile(t, workspace, "app.txt", "manual unsaved edit\n")
	before := commitGit(t, workspace, "status", "--porcelain")
	message.Action = "git-observe-commit"
	response := handleParentOperation(context.Background(), Assignment{WorkspaceFolder: workspace}, message)
	if response.Error != "" || response.CommitSHA != first {
		t.Fatalf("same operation did not recover its commit: %q, %s", response.CommitSHA, response.Error)
	}
	if count := commitGit(t, workspace, "rev-list", "--count", "HEAD"); count != "2" {
		t.Fatalf("recovery created another commit: %s", count)
	}
	if after := commitGit(t, workspace, "status", "--porcelain"); after != before {
		t.Fatalf("recovery changed manual files: %q -> %q", before, after)
	}
}

func TestPrepareCommitRecoveryRejectsFalseIdentity(t *testing.T) {
	for _, variant := range []string{"prefix", "body", "parent", "title", "missing-id"} {
		t.Run(variant, func(t *testing.T) {
			workspace, message := commitRepository(t)
			if variant == "parent" {
				commitFile(t, workspace, "intervening.txt", "another commit\n")
				commitGit(t, workspace, "add", "-A")
				commitGit(t, workspace, "commit", "-m", "Intervening manual commit")
			}
			commitFile(t, workspace, "app.txt", "implementation\n")
			commitGit(t, workspace, "add", "-A")
			body := message.CommitMessage + "\n\nFactory-Operation: " + message.OperationID
			if variant == "prefix" {
				body += "-different"
			}
			if variant == "body" {
				body = message.CommitMessage + "\n\nQuoted Factory-Operation: " + message.OperationID
			}
			if variant == "title" {
				body = "Another implementation\n\nFactory-Operation: " + message.OperationID
			}
			commitGit(t, workspace, "commit", "-m", body)
			if variant == "missing-id" {
				message.OperationID = ""
			}
			head := commitGit(t, workspace, "rev-parse", "HEAD")
			commitFile(t, workspace, "manual.txt", "preserve me\n")
			if _, err := prepareCommit(context.Background(), workspace, message); err == nil {
				t.Fatal("accepted a different commit as the exact operation")
			}
			if commitGit(t, workspace, "rev-parse", "HEAD") != head {
				t.Fatal("rejected recovery changed HEAD")
			}
			if commitGit(t, workspace, "status", "--porcelain") != "?? manual.txt" {
				t.Fatal("rejected recovery changed manual work")
			}
		})
	}
}

func TestUnconfirmedPrepareRecoveryNeverCommitsLaterManualWork(t *testing.T) {
	workspace, message := commitRepository(t)
	commitFile(t, workspace, "app.txt", "implementation\n")
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	commands := t.TempDir()
	shim := "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = commit ]; then exit 73; fi\ndone\nexec \"$FACTORY_RECOVERY_REAL_GIT\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(commands, "git"), []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	originalPath := os.Getenv("PATH")
	t.Setenv("FACTORY_RECOVERY_REAL_GIT", realGit)
	t.Setenv("PATH", commands+string(os.PathListSeparator)+originalPath)
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil {
		t.Fatal("fixture did not lose preparation after staging")
	}
	t.Setenv("PATH", originalPath)
	index := commitGit(t, workspace, "diff", "--cached")
	if index == "" {
		t.Fatal("fixture did not stage the original implementation")
	}
	commitFile(t, workspace, "app.txt", "later manual edit\n")
	commitFile(t, workspace, "manual.txt", "later manual file\n")
	status := commitGit(t, workspace, "status", "--porcelain")
	message.Action = "git-observe-commit"
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil {
		t.Fatal("observation committed later manual work instead of retaining uncertainty")
	}
	if commitGit(t, workspace, "rev-parse", "HEAD") != message.ExpectedSHA {
		t.Fatal("observation changed HEAD")
	}
	if commitGit(t, workspace, "diff", "--cached") != index || commitGit(t, workspace, "status", "--porcelain") != status {
		t.Fatal("observation changed the staged or manual work")
	}
	for name, expected := range map[string]string{"app.txt": "later manual edit\n", "manual.txt": "later manual file\n"} {
		content, err := os.ReadFile(filepath.Join(workspace, name))
		if err != nil || string(content) != expected {
			t.Fatalf("observation changed %s: %q, %v", name, content, err)
		}
	}
}

func TestPushCommitRecoveryObservesExactRemote(t *testing.T) {
	workspace, message := commitRepository(t)
	remote := t.TempDir()
	commitGit(t, remote, "init", "--bare")
	commitGit(t, workspace, "remote", "add", "origin", remote)
	commitGit(t, workspace, "push", "origin", "HEAD:refs/heads/"+message.Branch)
	// Canonical checkout origin is a read-only, startup-scoped endpoint. Push
	// must use the exact forge destination supplied by the authorized operation.
	commitGit(t, workspace, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "expired-source"))
	message.RepositoryURL = remote
	commitFile(t, workspace, "app.txt", "implementation\n")
	sha, err := prepareCommit(context.Background(), workspace, message)
	if err != nil {
		t.Fatal(err)
	}
	message.CommitSHA = sha
	first, err := pushCommit(context.Background(), workspace, message)
	if err != nil || first != sha {
		t.Fatalf("push failed: %q, %v", first, err)
	}
	if commitGit(t, workspace, "remote", "get-url", "origin") == remote {
		t.Fatal("push replaced the canonical checkout origin")
	}
	commitFile(t, workspace, "manual.txt", "preserve after push\n")
	// Ref observation must recover the outcome without another push invocation.
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	commands := t.TempDir()
	shim := "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = push ]; then exit 73; fi\ndone\nexec \"$FACTORY_RECOVERY_REAL_GIT\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(commands, "git"), []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FACTORY_RECOVERY_REAL_GIT", realGit)
	t.Setenv("PATH", commands+string(os.PathListSeparator)+os.Getenv("PATH"))
	second, err := pushCommit(context.Background(), workspace, message)
	if err != nil || second != first {
		t.Fatalf("accepted push did not recover: %q, %v", second, err)
	}
	if commitGit(t, workspace, "status", "--porcelain") != "?? manual.txt" {
		t.Fatal("push recovery changed manual files")
	}
	commitGit(t, remote, "update-ref", "refs/heads/"+message.Branch, message.ExpectedSHA)
	// A different expected parent cannot authorize the present remote head.
	message.ExpectedSHA = "1111111111111111111111111111111111111111"
	if _, err := pushCommit(context.Background(), workspace, message); err == nil {
		t.Fatal("accepted a changed remote head")
	}
	message.ExpectedSHA = commitGit(t, workspace, "rev-parse", "HEAD^")
	destination := message.RepositoryURL
	message.RepositoryURL = filepath.Join(t.TempDir(), "unavailable-forge")
	if _, err := pushCommit(context.Background(), workspace, message); err == nil || err.Error() != "remote branch could not be observed" {
		t.Fatalf("remote read failure was reported as a branch conflict: %v", err)
	}
	message.RepositoryURL = destination
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "Later manual work")
	if _, err := pushCommit(context.Background(), workspace, message); err == nil {
		t.Fatal("accepted a changed local head")
	}
}
