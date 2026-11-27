package skills

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/trust"
)

func InstallAdmittedSkills(ctx context.Context, assignment protocol.Assignment, data string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(data) > 7100000 || !json.Valid([]byte(data)) {
		return errors.New("invalid admitted skill package")
	}
	agent := false
	for _, channel := range assignment.Channels {
		if channel.Kind == "agent" {
			agent = true
		}
	}
	if !agent {
		return errors.New("skill packages require an assigned Build runtime")
	}
	if !protocol.IdentityPattern.MatchString(assignment.RuntimeAttemptID) || assignment.Generation == 0 ||
		!protocol.UUIDPattern.MatchString(assignment.NativeActorUID()) ||
		assignment.WorkspaceFolder != "/var/lib/factory/source/project" ||
		assignment.ConnectorStateDir != trust.BootstrapStateDirectory {
		return errors.New("skill installation requires the assigned native control identity")
	}
	return installNativeSkills(ctx, assignment, data)
}
