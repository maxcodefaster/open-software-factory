package connector

import (
	"context"
	"strings"
	"testing"
)

func integrationFixture(t *testing.T, conflict bool) (string, Message) {
	t.Helper()
	workspace, message := commitRepository(t)
	commitGit(t, workspace, "checkout", "-b", message.Branch)
	commitFile(t, workspace, "app.txt", "ticket B\n")
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "Ticket B")
	message.ExpectedSHA = commitGit(t, workspace, "rev-parse", "HEAD")
	commitGit(t, workspace, "checkout", "main")
	name := "other.txt"
	if conflict {
		name = "app.txt"
	}
	commitFile(t, workspace, name, "ticket A\n")
	commitGit(t, workspace, "add", "-A")
	commitGit(t, workspace, "commit", "-m", "Ticket A")
	message.MergeParentSHA = commitGit(t, workspace, "rev-parse", "HEAD")
	message.RepositoryURL = workspace
	message.Action = "git-prepare-integration"
	commitGit(t, workspace, "checkout", message.Branch)
	return workspace, message
}

func TestIntegrationCommitsExactParentsAndRecoversWithoutTouchingFiles(t *testing.T) {
	workspace, message := integrationFixture(t, false)
	sha, err := prepareCommit(context.Background(), workspace, message)
	if err != nil {
		t.Fatal(err)
	}
	if parents := commitGit(t, workspace, "show", "-s", "--format=%P", sha); parents != message.ExpectedSHA+" "+message.MergeParentSHA {
		t.Fatalf("wrong integrated ancestry: %s", parents)
	}
	commitFile(t, workspace, "manual.txt", "retained later work\n")
	message.Action = "git-observe-commit"
	recovered, err := prepareCommit(context.Background(), workspace, message)
	if err != nil || recovered != sha {
		t.Fatalf("did not recover exact merge: %s, %v", recovered, err)
	}
	if commitGit(t, workspace, "status", "--porcelain") != "?? manual.txt" {
		t.Fatal("merge recovery touched later work")
	}
	message.MergeParentSHA = strings.Repeat("a", 40)
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil {
		t.Fatal("accepted a different integration parent")
	}
}

func TestIntegrationConflictsRemainForExistingImplementer(t *testing.T) {
	workspace, message := integrationFixture(t, true)
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil || err.Error() != "integration has conflicts" {
		t.Fatalf("expected a retained conflict: %v", err)
	}
	if head := commitGit(t, workspace, "rev-parse", "HEAD"); head != message.ExpectedSHA {
		t.Fatal("conflict changed the approved branch head")
	}
	if merge := commitGit(t, workspace, "rev-parse", "MERGE_HEAD"); merge != message.MergeParentSHA {
		t.Fatal("conflict lost its exact source")
	}
	message.Action = "git-observe-commit"
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil {
		t.Fatal("observation repeated an unfinished merge")
	}
	commitFile(t, workspace, "app.txt", "both intentions resolved\n")
	message.Action = "git-prepare-commit"
	if _, err := prepareCommit(context.Background(), workspace, message); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationRejectsDirtySourceAndUnadmittedMerge(t *testing.T) {
	workspace, message := integrationFixture(t, false)
	commitFile(t, workspace, "manual.txt", "do not include\n")
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil || err.Error() != "integration requires a clean checkout" {
		t.Fatalf("accepted dirty integration: %v", err)
	}
	workspace, message = integrationFixture(t, true)
	_, _ = prepareCommit(context.Background(), workspace, message)
	message.Action = "git-prepare-commit"
	message.MergeParentSHA = ""
	if _, err := prepareCommit(context.Background(), workspace, message); err == nil || err.Error() != "an ordinary commit cannot accept an unadmitted merge" {
		t.Fatalf("accepted unadmitted merge: %v", err)
	}
}
