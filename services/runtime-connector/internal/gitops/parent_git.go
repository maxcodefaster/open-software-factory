package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/repositoryurl"
)

// The Dev Container user can write the repository's config, hooks, attributes
// and fsmonitor settings, so every Git process the privileged Parent starts uses
// this shared hardening. -c values override repository config for the same key.
var hardenedGitConfig = []string{
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "credential.helper=",
	"-c", "commit.gpgSign=false",
	"-c", "protocol.ext.allow=never",
}

// Only these inherited variables reach Parent Git. Everything else in the
// Connector's environment, including tokens and Runtime grants, stays out.
var gitEnvironmentAllowlist = []string{
	"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "CURL_CA_BUNDLE",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
	"http_proxy", "https_proxy", "no_proxy", "all_proxy",
}

func HardenedGitEnvironment(extra ...string) []string {
	environment := []string{
		"HOME=/nonexistent",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_ATTR_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0",
		"GIT_ALLOW_PROTOCOL=file:http:https",
	}
	for _, name := range gitEnvironmentAllowlist {
		if value, present := os.LookupEnv(name); present {
			environment = append(environment, name+"="+value)
		}
	}
	return append(environment, extra...)
}

// HardenedGitCommand builds a Git process with hardened config and a scrubbed
// environment. An empty workspace runs outside any repository (clone).
func HardenedGitCommand(ctx context.Context, workspace string, config []string, arguments ...string) *exec.Cmd {
	base := append([]string{}, hardenedGitConfig...)
	if workspace != "" {
		base = append(base, "-c", "safe.directory="+workspace)
	}
	base = append(base, config...)
	if workspace != "" {
		base = append(base, "-C", workspace)
	}
	command := procutil.OwnedCommand(ctx, "git", append(base, arguments...)...)
	command.Env = HardenedGitEnvironment()
	return command
}

func GitOutput(ctx context.Context, workspace string, arguments ...string) (string, error) {
	return gitOutputWithEnv(ctx, workspace, nil, arguments...)
}

type nativeCommitGitKey struct{}

func WithNativeCommitGit(ctx context.Context, enabled bool) context.Context {
	return context.WithValue(ctx, nativeCommitGitKey{}, enabled)
}

func WorkspaceGitCommand(ctx context.Context, workspace string, arguments ...string) *exec.Cmd {
	if ctx.Value(nativeCommitGitKey{}) == true {
		// Native Source has one development owner, not the legacy shared-root
		// metadata contract. Local commit/filter work must never become root-owned
		// or inherit network credentials. This fact is set only by native Parent.
		command := HardenedGitCommand(ctx, workspace, nil, arguments...)
		if os.Geteuid() == 0 {
			if command.SysProcAttr == nil {
				command.SysProcAttr = &syscall.SysProcAttr{}
			}
			command.SysProcAttr.Credential = &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}}
		}
		return command
	}
	// Parent Git owns writes, but the canonical Source and non-root Dev Container
	// must still read its resulting refs and objects. Keep the Parent's private
	// bootstrap umask; scope this mode to Git's own metadata only.
	return HardenedGitCommand(ctx, workspace, []string{"-c", "core.sharedRepository=0644"}, arguments...)
}

func gitOutputWithEnv(ctx context.Context, workspace string, environment []string, arguments ...string) (string, error) {
	command := WorkspaceGitCommand(ctx, workspace, arguments...)
	if environment != nil {
		command.Env = environment
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %w: %s", arguments[0], err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func PrepareCommit(ctx context.Context, workspace string, message protocol.Message) (string, error) {
	if message.OperationID == "" || message.ExpectedSHA == "" || message.CommitMessage == "" || message.AuthorName == "" || message.AuthorEmail == "" {
		return "", errors.New("commit operation is incomplete")
	}
	timeout := procutil.GitOperationTimeout
	if message.Action == "git-prepare-integration" {
		timeout = procutil.GitRemoteTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	head, err := GitOutput(ctx, workspace, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	commitMessage := message.CommitMessage + "\n\nFactory-Operation: " + message.OperationID
	expectedParents := message.ExpectedSHA
	if message.MergeParentSHA != "" {
		if !ValidCommitSHA(message.MergeParentSHA) || message.MergeParentSHA == message.ExpectedSHA {
			return "", errors.New("integration parent is invalid")
		}
		expectedParents += " " + message.MergeParentSHA
	}
	if head != message.ExpectedSHA {
		body, bodyErr := GitOutput(ctx, workspace, "show", "-s", "--format=%B", "HEAD")
		parents, parentErr := GitOutput(ctx, workspace, "show", "-s", "--format=%P", "HEAD")
		if bodyErr == nil && parentErr == nil && body == strings.TrimSpace(commitMessage) && parents == expectedParents {
			return head, nil
		}
		return "", errors.New("workspace HEAD no longer matches the commit intent")
	}
	if message.Action == "git-observe-commit" {
		return "", errors.New("the exact prepared commit was not found; current files were not committed")
	}
	if message.Action == "git-prepare-integration" {
		if message.MergeParentSHA == "" || message.RepositoryURL == "" {
			return "", errors.New("integration intent is incomplete")
		}
		if !repositoryurl.Valid(message.RepositoryURL) {
			return "", errors.New("integration source is not an admitted repository URL")
		}
		status, err := GitOutput(ctx, workspace, "status", "--porcelain")
		if err != nil || status != "" {
			return "", errors.New("integration requires a clean checkout")
		}
		if _, err := GitOutput(ctx, workspace, "rev-parse", "--verify", "MERGE_HEAD"); err == nil {
			return "", errors.New("another integration is already in progress")
		}
		if ctx.Value(nativeCommitGitKey{}) == true {
			if err := fetchNativeIntegration(ctx, workspace, message); err != nil {
				return "", err
			}
		} else {
			environment, cleanup, err := commitGitEnvironment(message)
			if err != nil {
				return "", err
			}
			defer cleanup()
			if _, err := gitOutputWithEnv(ctx, workspace, environment, "fetch", "--no-tags", "--", message.RepositoryURL, message.MergeParentSHA); err != nil {
				return "", errors.New("integration source could not be fetched")
			}
		}
		_, mergeError := GitOutput(ctx, workspace,
			"-c", "user.name="+message.AuthorName, "-c", "user.email="+message.AuthorEmail,
			"merge", "--no-ff", "--no-commit", message.MergeParentSHA)
		// Conflicts also materialize files that the retained implementer must
		// be able to read and resolve in its normal development identity.
		if ctx.Value(nativeCommitGitKey{}) != true {
			if err := EnsureTrackedWorkspaceOwnership(ctx, workspace); err != nil {
				return "", err
			}
		}
		if mergeError != nil {
			unmerged, observationErr := GitOutput(ctx, workspace, "ls-files", "--unmerged")
			if observationErr == nil && unmerged != "" {
				return "", errors.New("integration has conflicts")
			}
			return "", errors.New("integration outcome is unconfirmed")
		}
	}
	mergeHead, mergeErr := GitOutput(ctx, workspace, "rev-parse", "--verify", "MERGE_HEAD")
	if message.MergeParentSHA != "" {
		if mergeErr != nil || mergeHead != message.MergeParentSHA {
			return "", errors.New("workspace merge no longer matches the integration intent")
		}
	} else if mergeErr == nil {
		return "", errors.New("an ordinary commit cannot accept an unadmitted merge")
	}
	status, err := GitOutput(ctx, workspace, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if status == "" && message.MergeParentSHA == "" {
		return "", errors.New("workspace has no changes to commit")
	}
	if _, err := GitOutput(ctx, workspace, "add", "-A"); err != nil {
		return "", err
	}
	command := WorkspaceGitCommand(
		ctx, workspace,
		"-c", "user.name="+message.AuthorName, "-c", "user.email="+message.AuthorEmail,
		"commit", "--cleanup=verbatim", "-m", commitMessage,
	)
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git commit failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return GitOutput(ctx, workspace, "rev-parse", "HEAD")
}

func ValidCommitSHA(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func commitGitEnvironment(message protocol.Message) ([]string, func(), error) {
	environment := HardenedGitEnvironment()
	if message.Username == "" && message.Password == "" {
		return environment, func() {}, nil
	}
	askpass, err := os.CreateTemp("", "factory-git-askpass-*")
	if err != nil {
		return nil, nil, err
	}
	path := askpass.Name()
	cleanup := func() { os.Remove(path) }
	if _, err := askpass.WriteString("#!/bin/sh\ncase \"$1\" in *Username*) printf %s \"$FACTORY_GIT_USERNAME\";; *) printf %s \"$FACTORY_GIT_PASSWORD\";; esac\n"); err != nil {
		askpass.Close()
		cleanup()
		return nil, nil, err
	}
	if err := askpass.Close(); err != nil {
		cleanup()
		return nil, nil, err
	}
	if err := os.Chmod(path, 0700); err != nil {
		cleanup()
		return nil, nil, err
	}
	return append(environment, "GIT_ASKPASS="+path, "FACTORY_GIT_USERNAME="+message.Username, "FACTORY_GIT_PASSWORD="+message.Password), cleanup, nil
}

func PushCommit(ctx context.Context, workspace string, message protocol.Message) (string, error) {
	if message.Branch == "" || message.ExpectedSHA == "" || message.CommitSHA == "" {
		return "", errors.New("push operation is incomplete")
	}
	ctx, cancel := context.WithTimeout(ctx, procutil.GitRemoteTimeout)
	defer cancel()
	head, err := GitOutput(ctx, workspace, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if head != message.CommitSHA {
		return "", errors.New("workspace HEAD no longer matches the push intent")
	}
	if ctx.Value(nativeCommitGitKey{}) == true {
		if !repositoryurl.Valid(message.RepositoryURL) {
			return "", errors.New("push destination is not an admitted repository URL")
		}
		return pushNativeCommit(ctx, workspace, message)
	}
	environment, cleanup, err := commitGitEnvironment(message)
	if err != nil {
		return "", err
	}
	defer cleanup()
	ref := "refs/heads/" + message.Branch
	destination := message.RepositoryURL
	if destination == "" {
		return "", errors.New("push destination is missing")
	}
	if !repositoryurl.Valid(destination) {
		return "", errors.New("push destination is not an admitted repository URL")
	}
	remote, err := gitOutputWithEnv(ctx, workspace, environment, "ls-remote", "--", destination, ref)
	if err != nil {
		return "", errors.New("remote branch could not be observed")
	}
	remoteFields := strings.Fields(remote)
	remoteSHA := ""
	if len(remoteFields) > 0 {
		remoteSHA = remoteFields[0]
	}
	if remoteSHA == message.CommitSHA {
		return remoteSHA, nil
	}
	if remoteSHA != message.ExpectedSHA {
		return "", errors.New("remote branch no longer matches the push intent")
	}
	command := WorkspaceGitCommand(ctx, workspace, "push", "--porcelain", "--", destination, message.CommitSHA+":"+ref)
	command.Env = environment
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git push failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	remote, err = gitOutputWithEnv(ctx, workspace, environment, "ls-remote", "--", destination, ref)
	if err != nil {
		return "", err
	}
	remoteFields = strings.Fields(remote)
	if len(remoteFields) == 0 || remoteFields[0] != message.CommitSHA {
		return "", errors.New("pushed commit was not observed on the remote branch")
	}
	return remoteFields[0], nil
}

func CheckoutProject(ctx context.Context, assignment protocol.Assignment) error {
	if _, err := os.Stat(assignment.WorkspaceFolder); err == nil {
		ctx, cancel := context.WithTimeout(ctx, procutil.GitOperationTimeout)
		defer cancel()
		if _, gitErr := os.Stat(filepath.Join(assignment.WorkspaceFolder, ".git")); gitErr != nil {
			return errors.New("workspace folder exists but is not the assigned Git checkout")
		}
		repositoryIdentity, identityErr := HardenedGitCommand(
			ctx, assignment.WorkspaceFolder, nil,
			"config", "--get", "factory.repositoryIdentity",
		).Output()
		if identityErr != nil || strings.TrimSpace(string(repositoryIdentity)) != assignment.RepositoryIdentity {
			return errors.New("workspace folder exists but its repository identity does not match the assignment")
		}
		var originErr error
		if assignment.NativeActorUID() != "" {
			// The verified native checkout belongs to the development user. A
			// root Git config rewrite would create metadata its fenced Source
			// service cannot preserve. This fixed operation needs no network.
			_, originErr = PersonalGitCommand(ctx, assignment.WorkspaceFolder,
				"remote", "set-url", "origin", assignment.RepositoryURL)
		} else {
			originErr = WorkspaceGitCommand(ctx, assignment.WorkspaceFolder,
				"remote", "set-url", "origin", assignment.RepositoryURL).Run()
		}
		if originErr != nil {
			return errors.New("Workspace Git origin could not be refreshed")
		}
		if assignment.PreserveWorkspace {
			if err := EnsureSharedGitReadable(assignment.WorkspaceFolder); err != nil {
				return err
			}
			return EnsureTrackedWorkspaceOwnership(ctx, assignment.WorkspaceFolder)
		}
		head, headErr := WorkspaceGitCommand(
			ctx, assignment.WorkspaceFolder, "rev-parse", "HEAD",
		).Output()
		if headErr != nil || strings.TrimSpace(string(head)) != assignment.Revision {
			return errors.New("workspace folder does not contain the assigned revision")
		}
		status, statusErr := WorkspaceGitCommand(
			ctx, assignment.WorkspaceFolder, "status", "--porcelain",
		).Output()
		if statusErr != nil || len(bytes.TrimSpace(status)) != 0 {
			return errors.New("workspace folder is not a clean checkout")
		}
		return EnsureSharedGitReadable(assignment.WorkspaceFolder)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect workspace folder: %w", err)
	}
	if assignment.PreserveWorkspace {
		return errors.New("canonical Workspace source is not initialized")
	}
	if err := os.MkdirAll(filepath.Dir(assignment.WorkspaceFolder), 0755); err != nil {
		return fmt.Errorf("create workspace parent: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, procutil.GitCloneTimeout)
	defer cancel()
	command := HardenedGitCommand(ctx, "", nil, "clone", "--no-checkout", "--", assignment.RepositoryURL, assignment.WorkspaceFolder)
	if err := command.Run(); err != nil {
		return errors.New("Project repository checkout failed; check repository access and connectivity")
	}
	if err := HardenedGitCommand(ctx, assignment.WorkspaceFolder, nil, "checkout", "--detach", assignment.Revision).Run(); err != nil {
		return errors.New("Assigned Project revision could not be checked out")
	}
	if output, err := HardenedGitCommand(
		ctx, assignment.WorkspaceFolder, nil, "config", "factory.repositoryIdentity", assignment.RepositoryIdentity,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("record workspace repository identity: %w: %s", err, output)
	}
	if output, err := procutil.OwnedCommand(ctx, "chown", "-R", "1000:1000", assignment.WorkspaceFolder).CombinedOutput(); err != nil {
		return fmt.Errorf("assign Project checkout ownership: %w: %s", err, output)
	}
	return nil
}
