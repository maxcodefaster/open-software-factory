package connector

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParentGitEnvironmentIsAnAllowlist(t *testing.T) {
	t.Setenv("FACTORY_CONNECTOR_TOKEN", "must-not-leak")
	t.Setenv("FACTORY_SECRET_GRANT", "must-not-leak")
	t.Setenv("GIT_DIR", "/attacker")
	t.Setenv("GIT_SSH_COMMAND", "touch /tmp/pwned")
	t.Setenv("LANG", "C")
	environment := hardenedGitEnvironment()
	joined := strings.Join(environment, "\n")
	for _, forbidden := range []string{"must-not-leak", "GIT_DIR=", "GIT_SSH_COMMAND"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("Parent Git inherited %q", forbidden)
		}
	}
	for _, required := range []string{"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_ALLOW_PROTOCOL=file:http:https", "LANG=C"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("Parent Git environment is missing %q: %v", required, environment)
		}
	}
	credentialed, cleanup, err := commitGitEnvironment(Message{Username: "user", Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	joined = strings.Join(credentialed, "\n")
	if strings.Contains(joined, "must-not-leak") || !strings.Contains(joined, "GIT_ASKPASS=") || !strings.Contains(joined, "GIT_TERMINAL_PROMPT=0") {
		t.Fatalf("credentialed Git environment is wrong: %v", credentialed)
	}
}

func TestParentGitIgnoresRepositoryHooksAndFsmonitor(t *testing.T) {
	workspace, message := commitRepository(t)
	marker := filepath.Join(t.TempDir(), "executed")
	script := "#!/bin/sh\necho ran >> " + marker + "\nexit 0\n"
	hooks := filepath.Join(workspace, ".git", "hooks")
	for _, name := range []string{"pre-commit", "commit-msg", "post-commit", "reference-transaction"} {
		if err := os.WriteFile(filepath.Join(hooks, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	fsmonitor := filepath.Join(t.TempDir(), "fsmonitor")
	if err := os.WriteFile(fsmonitor, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	// The Dev Container user controls repository config, so it can also point
	// hooks and the file system monitor at attacker-chosen programs.
	run := func(arguments ...string) {
		t.Helper()
		command := workspaceGitCommand(context.Background(), workspace, arguments...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, output)
		}
	}
	run("config", "core.fsmonitor", fsmonitor)
	run("config", "core.hooksPath", hooks)
	commitFile(t, workspace, "app.txt", "implementation\n")
	if _, err := prepareCommit(context.Background(), workspace, message); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("repository-controlled program ran as the privileged Parent")
	}
}

func TestParentGitRejectsNonAdmittedRepositoryURLs(t *testing.T) {
	for _, destination := range []string{
		"--upload-pack=touch /tmp/pwned",
		"ext::sh -c touch% /tmp/pwned",
		"ssh://attacker.example/repository.git",
		"/local/path/repository",
		"https://user:secret@forge.example/repository.git",
	} {
		workspace, message := integrationFixture(t, false)
		message.RepositoryURL = destination
		if _, err := prepareCommit(context.Background(), workspace, message); err == nil || !strings.Contains(err.Error(), "admitted repository URL") {
			t.Fatalf("integration accepted %q: %v", destination, err)
		}
		message.Action = "git-push"
		message.CommitSHA = commitGit(t, workspace, "rev-parse", "HEAD")
		if _, err := pushCommit(context.Background(), workspace, message); err == nil || !strings.Contains(err.Error(), "admitted repository URL") {
			t.Fatalf("push accepted %q: %v", destination, err)
		}
	}
}

func TestParentGitStopsWhenItsContextEnds(t *testing.T) {
	workspace, message := commitRepository(t)
	commitFile(t, workspace, "app.txt", "implementation\n")
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	commands := t.TempDir()
	shim := "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = status ]; then exec sleep 30; fi\ndone\nexec " + realGit + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(commands, "git"), []byte(shim), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", commands+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := prepareCommit(ctx, workspace, message); err == nil {
		t.Fatal("a hung Git process completed")
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("a hung Git process was not stopped by its context")
	}
}
