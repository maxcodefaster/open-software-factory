package connector

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/browser"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/gitops"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

// Read the admitted Source, never checkout claims supplied by a Browser Actor.
// The caller owns native Source authority.
// Only fixed, hardened Git queries run here; no Docker or checkout mutation.
func readBrowserCheckoutContext(ctx context.Context, assignment Assignment, scope browser.RuntimeRequest, app string) (*browser.InspectionContext, error) {
	workspace := assignment.WorkspaceFolder
	if workspace == "" || !filepath.IsAbs(workspace) || filepath.Clean(workspace) != workspace {
		return nil, errors.New("browser checkout context is unavailable")
	}
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() {
		return nil, errors.New("browser checkout context is unavailable")
	}
	declared := false
	for _, channel := range assignment.Channels {
		if channel.Kind == "app" && channel.Name == app && protocol.ChannelPattern.MatchString(app) {
			declared = true
			break
		}
	}
	if !declared {
		return nil, errors.New("browser App is not declared in this Workspace")
	}
	read := func(arguments ...string) ([]byte, error) {
		command := gitops.HardenedGitCommand(ctx, workspace, nil, append([]string{"--no-optional-locks"}, arguments...)...)
		var output browser.DockerOutput
		command.Stdout, command.Stderr = &output, io.Discard
		if err := command.Run(); err != nil {
			return nil, err
		}
		return output.Bytes(), nil
	}
	root, err := read("rev-parse", "--show-toplevel")
	if err != nil {
		return nil, errors.New("browser checkout root could not be established")
	}
	rootInfo, err := os.Stat(strings.TrimSpace(string(root)))
	if err != nil || !os.SameFile(info, rootInfo) {
		return nil, errors.New("browser checkout root does not match the admitted Source")
	}
	head, err := read("rev-parse", "--verify", "HEAD^{commit}")
	if err != nil || !browser.CommitPattern.MatchString(strings.TrimSpace(string(head))) {
		return nil, errors.New("browser checkout HEAD could not be established")
	}
	status, err := read("status", "--porcelain=v1")
	if err != nil {
		return nil, errors.New("browser checkout modification state is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &browser.InspectionContext{SessionID: scope.SessionID, TurnID: scope.TurnID, AttemptID: assignment.RuntimeAttemptID,
		Generation: assignment.Generation, App: app, HeadCommit: strings.TrimSpace(string(head)), WorkingTreeModified: len(status) > 0,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}
