package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/repositoryurl"
)

type personalGitRequest struct {
	Action       string `json:"action"`
	Branch       string `json:"branch"`
	Path         string `json:"path,omitempty"`
	ExpectedHead string `json:"expectedHead,omitempty"`
	Repository   string `json:"repository,omitempty"`
	Message      string `json:"message,omitempty"`
	AuthorName   string `json:"authorName,omitempty"`
	AuthorEmail  string `json:"authorEmail,omitempty"`
}

type personalGitFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type personalGitStatus struct {
	Head   string            `json:"head"`
	Branch string            `json:"branch"`
	Files  []personalGitFile `json:"files"`
}

var personalGitOperation = regexp.MustCompile(`^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$`)
var personalGitSHA = regexp.MustCompile(`^[a-f0-9]{40}(?:[a-f0-9]{24})?$`)

type gitOutputBuffer struct {
	bytes.Buffer
	exceeded bool
}

func (buffer *gitOutputBuffer) Write(data []byte) (int, error) {
	if buffer.Len()+len(data) > 256<<10 {
		buffer.exceeded = true
		return 0, errors.New("Git output exceeds 256 KiB; narrow the selected diff")
	}
	return buffer.Buffer.Write(data)
}

// Git belongs to the user's execution Sandbox, not the privileged Source
// service or the IDE backend. Project filters can never run as the parent.
func personalGitCommand(ctx context.Context, workspace string, args ...string) (string, error) {
	metadata := filepath.Join(workspace, ".git")
	info, err := os.Lstat(metadata)
	if err != nil || !info.IsDir() {
		return "", errors.New("Workspace Git metadata is unavailable")
	}
	base := []string{"-c", "safe.directory=" + workspace, "-c", "core.hooksPath=/dev/null",
		"-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "commit.gpgSign=false",
		"-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never",
		"--git-dir=" + metadata, "--work-tree=" + workspace, "-C", workspace}
	command := exec.CommandContext(ctx, "git", append(base, args...)...)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/coder",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
		"GIT_REFLOG_ACTION=factory-personal-git"}
	if os.Geteuid() == 0 {
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000}}
	}
	var output gitOutputBuffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		if output.exceeded {
			return "", errors.New("Git output exceeds 256 KiB. Inspect the selected file in the terminal")
		}
		var exited *exec.ExitError
		if len(args) > 0 && args[0] == "diff" && errors.As(err, &exited) &&
			exited.ExitCode() == 1 && strings.Contains(strings.Join(args, "\x00"), "--no-index") {
			return output.String(), nil
		}
		// Git can echo a fetch URL. Never return its operation capability.
		return "", errors.New("Git command failed. Check the working tree, branch and repository access")
	}
	return output.String(), nil
}

func readPersonalGitStatus(ctx context.Context, workspace string) (personalGitStatus, error) {
	status := personalGitStatus{Files: []personalGitFile{}}
	head, err := personalGitCommand(ctx, workspace, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return status, err
	}
	status.Head = strings.TrimSpace(head)
	branch, err := personalGitCommand(ctx, workspace, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err == nil {
		status.Branch = strings.TrimSpace(branch)
	}
	raw, err := personalGitCommand(ctx, workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return status, err
	}
	entries := strings.Split(raw, "\x00")
	for index := 0; index < len(entries); index++ {
		entry := entries[index]
		if entry == "" {
			continue
		}
		if len(entry) < 4 || len(status.Files) >= 1000 {
			return status, errors.New("Git status is too large or invalid")
		}
		status.Files = append(status.Files, personalGitFile{Path: entry[3:], Status: entry[:2]})
		if strings.ContainsAny(entry[:2], "RC") {
			index++ // -z emits the original rename/copy path as the next field.
		}
	}
	return status, nil
}

func personalGit(ctx context.Context, assignment Assignment, message Message) (string, error) {
	if !assignment.PreserveWorkspace || !personalGitOperation.MatchString(message.OperationID) {
		return "", errors.New("Git requires an assigned retained Workspace and operation identity")
	}
	var input personalGitRequest
	decoder := json.NewDecoder(strings.NewReader(message.Data))
	decoder.DisallowUnknownFields()
	if len(message.Data) > 8192 || decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		return "", errors.New("Invalid Workspace Git request")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	git := func(args ...string) (string, error) {
		return personalGitCommand(ctx, assignment.WorkspaceFolder, args...)
	}
	if _, err := git("check-ref-format", "refs/heads/"+input.Branch); err != nil {
		return "", errors.New("Invalid Project default branch")
	}
	status, err := readPersonalGitStatus(ctx, assignment.WorkspaceFolder)
	if err != nil {
		return "", err
	}
	switch input.Action {
	case "status":
	case "diff":
		if input.Path == "" || filepath.IsAbs(input.Path) || filepath.Clean(input.Path) != input.Path ||
			input.Path == ".." || strings.HasPrefix(input.Path, "../") || strings.Split(input.Path, "/")[0] == ".git" {
			return "", errors.New("Select one Project file for its diff")
		}
		diff, err := git("diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", input.Path)
		for _, file := range status.Files {
			if file.Path == input.Path && file.Status == "??" {
				diff, err = git("diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", input.Path)
				break
			}
		}
		if err != nil {
			return "", err
		}
		encoded, err := json.Marshal(map[string]string{"diff": diff})
		return string(encoded), err
	case "commit", "fetch", "pull":
		if !personalGitSHA.MatchString(input.ExpectedHead) || status.Head != input.ExpectedHead || status.Branch == "" {
			return "", errors.New("Workspace HEAD changed or is detached. Refresh Git status before continuing")
		}
		if input.Action == "commit" {
			if len(strings.TrimSpace(input.Message)) == 0 || len(input.Message) > 240 ||
				len(input.AuthorName) == 0 || len(input.AuthorName) > 200 ||
				len(input.AuthorEmail) == 0 || len(input.AuthorEmail) > 254 {
				return "", errors.New("Commit requires a short message and the authenticated author")
			}
			if len(status.Files) == 0 {
				return "", errors.New("There are no saved changes to commit")
			}
			if _, err := git("add", "-A", "--", "."); err != nil {
				return "", err
			}
			if _, err := git("-c", "user.name="+input.AuthorName, "-c", "user.email="+input.AuthorEmail,
				"commit", "--cleanup=verbatim", "-m", input.Message+"\n\nFactory-Operation: "+message.OperationID); err != nil {
				return "", err
			}
		} else {
			if !repositoryurl.Valid(input.Repository) {
				return "", errors.New("Fetch requires its Factory-scoped repository access")
			}
			if input.Action == "pull" && len(status.Files) != 0 {
				return "", errors.New("Commit your saved changes before pulling. No files were stashed or reset")
			}
			if _, err := git("fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "--", input.Repository,
				"+refs/heads/"+input.Branch+":refs/remotes/origin/"+input.Branch); err != nil {
				return "", err
			}
			if input.Action == "pull" {
				if _, err := git("merge", "--ff-only", "--no-edit", "refs/remotes/origin/"+input.Branch); err != nil {
					return "", errors.New("Cannot fast-forward. Your commits are retained; merge the fetched branch explicitly in the terminal")
				}
			}
		}
		status, err = readPersonalGitStatus(ctx, assignment.WorkspaceFolder)
		if err != nil {
			return "", err
		}
	default:
		return "", errors.New("Unsupported Workspace Git action")
	}
	encoded, err := json.Marshal(status)
	return string(encoded), err
}
