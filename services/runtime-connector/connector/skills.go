package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func installAdmittedSkills(ctx context.Context, assignment Assignment, data string) error {
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
	directory := assignment.ConnectorStateDir
	if directory == "" {
		directory = "/var/lib/factory/runtime-connector"
	}
	saved, err := os.ReadFile(filepath.Join(directory, assignment.RuntimeAttemptID+"-"+strconv.FormatUint(assignment.Generation, 10)+".json"))
	if err != nil {
		return errors.New("assigned primary identity is unavailable")
	}
	var state parentState
	if json.Unmarshal(saved, &state) != nil || state.RuntimeAttemptID != assignment.RuntimeAttemptID || state.Generation != assignment.Generation || state.ContainerID == "" {
		return errors.New("assigned primary identity does not match")
	}
	container, err := inspectContainer(state.ContainerID)
	if err != nil {
		return err
	}
	if container.Config.Labels[attemptLabel] != assignment.RuntimeAttemptID || container.Config.Labels[generationLabel] != strconv.FormatUint(assignment.Generation, 10) || !container.State.Running {
		return errors.New("skill installation primary ownership changed")
	}
	command := exec.CommandContext(ctx, "docker", "exec", "--interactive", "--user", "0:0", state.ContainerID, "/opt/factory/opencode/bun", "/opt/factory/opencode/server/install-skills.mjs")
	command.Stdin = strings.NewReader(data)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("install admitted skill packages: %w: %.2000s", err, output)
	}
	return nil
}
