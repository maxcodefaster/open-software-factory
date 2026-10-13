package connector

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var browserCommitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

type browserInspectionContext struct {
	SessionID           string `json:"sessionId"`
	TurnID              string `json:"turnId"`
	AttemptID           string `json:"runtimeAttemptId"`
	Generation          uint64 `json:"generation"`
	App                 string `json:"app"`
	HeadCommit          string `json:"headCommit"`
	WorkingTreeModified bool   `json:"workingTreeModified"`
	ObservedAt          string `json:"observedAt"`
}

func browserScreenshotDirectory(sessionID string) string {
	return filepath.Join("/tmp", "factory-build-browser-"+sessionID)
}

func (manager *browserRuntimeManager) inspectPrimary(ctx context.Context) (inspectedContainer, error) {
	observed, err := manager.docker(ctx, "inspect", manager.primaryID)
	var primaries []inspectedContainer
	if err != nil || json.Unmarshal(observed, &primaries) != nil || len(primaries) != 1 {
		return inspectedContainer{}, errors.New("browser primary container inspection was not confirmed")
	}
	primary := primaries[0]
	if primary.ID != manager.primaryID || !primary.State.Running || primary.Config.Labels[attemptLabel] != manager.assignment.RuntimeAttemptID ||
		primary.Config.Labels[generationLabel] != strconv.FormatUint(manager.assignment.Generation, 10) ||
		primary.Config.Labels["com.docker.compose.project"] != manager.assignment.ComposeProjectName {
		return inspectedContainer{}, errors.New("browser primary container no longer owns this Workspace generation")
	}
	return primary, nil
}

func (manager *browserRuntimeManager) observationContext(ctx context.Context, scope browserRuntimeRequest, app string) (*browserInspectionContext, error) {
	primary, err := manager.inspectPrimary(ctx)
	if err != nil {
		return nil, err
	}
	workspace, remote := manager.assignment.WorkspaceFolder, manager.assignment.RemoteWorkspaceFolder
	if workspace == "" || !filepath.IsAbs(workspace) || filepath.Clean(workspace) != workspace ||
		remote == "" || !filepath.IsAbs(remote) || filepath.Clean(remote) != remote {
		return nil, errors.New("browser checkout context is unavailable")
	}
	shared := false
	for _, mount := range primary.Mounts {
		if mount.Destination == remote {
			if shared || mount.Type != "bind" || mount.Source != workspace || !mount.RW {
				return nil, errors.New("browser checkout mount does not match the assigned shared workspace")
			}
			shared = true
		}
		if mount.Destination == remote+"/.git" || strings.HasPrefix(mount.Destination, remote+"/.git/") {
			return nil, errors.New("browser checkout mount does not match the assigned shared workspace")
		}
	}
	if !shared {
		return nil, errors.New("browser checkout mount does not match the assigned shared workspace")
	}
	// Git is optional in Project containers. The pinned parent already owns the
	// shared checkout and Git. Read it only after proving the exact primary bind;
	// disable repository executables and optional index writes during inspection.
	read := func(arguments ...string) ([]byte, error) {
		base := []string{"--no-optional-locks", "-c", "safe.directory=" + workspace, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", workspace}
		command := exec.CommandContext(ctx, "git", append(base, arguments...)...)
		var output browserDockerOutput
		command.Stdout, command.Stderr = &output, io.Discard
		if err := command.Run(); err != nil {
			return nil, err
		}
		return output.Bytes(), nil
	}
	head, err := read("rev-parse", "--verify", "HEAD^{commit}")
	if err != nil || !browserCommitPattern.MatchString(strings.TrimSpace(string(head))) {
		return nil, errors.New("browser checkout HEAD could not be established")
	}
	status, err := read("status", "--porcelain=v1")
	if err != nil {
		return nil, errors.New("browser checkout modification state is unavailable")
	}
	return &browserInspectionContext{SessionID: scope.SessionID, TurnID: scope.TurnID, AttemptID: manager.assignment.RuntimeAttemptID,
		Generation: manager.assignment.Generation, App: app, HeadCommit: strings.TrimSpace(string(head)), WorkingTreeModified: len(status) > 0,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

// The Parent owns the destination and serializes writes with session cleanup.
// The CLI only reports this derived path; it cannot create a late screenshot
// after Stop, choose a filesystem destination or retain a second screenshot.
func (manager *browserRuntimeManager) writeScreenshot(ctx context.Context, runtime *browserRuntime, result browserMCPContent) error {
	for _, content := range result.Content {
		if content.Type != "image" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(content.Data)
		if err != nil {
			return errors.New("browser screenshot encoding is invalid")
		}
		directory := browserScreenshotDirectory(runtime.scope.SessionID)
		if _, err := manager.docker(ctx, "exec", "--user", manager.primaryUser, manager.primaryID, "sh", "-c",
			`test ! -L "$1" && (test ! -e "$1" || test -d "$1") && mkdir -p -- "$1" && chmod 0700 -- "$1"`, "factory-browser-directory", directory); err != nil {
			return err
		}
		pending := filepath.Join(directory, ".pending.jpg")
		// Docker archive-copy cannot address tmpfs paths in a read-only primary.
		// Write bounded bytes through the exact remote user's stdin instead. The
		// exclusive pending file rejects existing files and symlinks.
		command := exec.CommandContext(ctx, "docker", "exec", "-i", "--user", manager.primaryUser, manager.primaryID,
			"sh", "-c", `set -C; umask 077; cat > "$1"`, "factory-browser-screenshot", pending)
		command.Stdin = bytes.NewReader(data)
		command.Stdout, command.Stderr = io.Discard, io.Discard
		if command.Run() != nil {
			return errors.New("browser screenshot publication was not confirmed")
		}
		if _, err := manager.docker(ctx, "exec", "--user", manager.primaryUser, manager.primaryID, "mv", "--", pending, filepath.Join(directory, "screenshot.jpg")); err != nil {
			return err
		}
	}
	return nil
}

func (manager *browserRuntimeManager) cleanScreenshot(ctx context.Context, scope browserRuntimeRequest) error {
	ids, err := manager.docker(ctx, "ps", "-aq", "--filter", "id="+manager.primaryID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(ids)) == "" {
		return nil
	}
	if _, err := manager.inspectPrimary(ctx); err != nil {
		return err
	}
	directory := browserScreenshotDirectory(scope.SessionID)
	_, err = manager.docker(ctx, "exec", "--user", manager.primaryUser, manager.primaryID, "sh", "-c",
		`test ! -L "$1" || exit 1; if test -d "$1"; then rm -f -- "$1/screenshot.jpg" "$1/.pending.jpg" && rmdir -- "$1"; fi; test ! -e "$1"`, "factory-browser-cleanup", directory)
	return err
}
