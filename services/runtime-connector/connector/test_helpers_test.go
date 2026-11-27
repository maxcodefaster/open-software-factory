package connector

import "testing"

func validAssignment() Assignment {
	return Assignment{
		Version:               AssignmentVersion,
		RuntimeAttemptID:      "runtime-test",
		Generation:            1,
		WorkspaceFolder:       "/workspace/outer",
		RemoteWorkspaceFolder: "/workspace/project",
		RepositoryURL:         "file:///factory/source/project.bundle",
		RepositoryIdentity:    "20e65e28-8bad-4c05-a063-3b629808d549",
		Revision:              "main",
		ActorTemplatePath:     ".devcontainer/devcontainer.json",
		ControlURL:            "wss://factory.example.test/runtime/connect",
		Channels: []Channel{{
			Name:       "app",
			Kind:       "app",
			Target:     "http://127.0.0.1:4300",
			HealthPath: "/health",
		}},
	}
}

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
	message.RepositoryURL = "file://" + workspace
	message.Action = "git-prepare-integration"
	commitGit(t, workspace, "checkout", message.Branch)
	return workspace, message
}
