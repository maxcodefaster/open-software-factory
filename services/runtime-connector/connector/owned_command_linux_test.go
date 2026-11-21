//go:build linux

package connector

import (
	"context"
	"os"
	"testing"
)

func TestOwnedNativeGitRetainsProcessGroupAndDevelopmentUser(t *testing.T) {
	ctx := context.WithValue(t.Context(), nativeCommitGitKey{}, true)
	command := workspaceGitCommand(ctx, "/workspace/project", "status")
	if command.SysProcAttr == nil || !command.SysProcAttr.Setpgid || command.Cancel == nil || command.WaitDelay == 0 {
		t.Fatal("native Source Git lost assigned-process cancellation or bounded pipe ownership")
	}
	if os.Geteuid() == 0 {
		user := command.SysProcAttr.Credential
		if user == nil || user.Uid != 1000 || user.Gid != 1000 || len(user.Groups) != 0 {
			t.Fatal("native Source Git lost its development UID/GID")
		}
	}
}
