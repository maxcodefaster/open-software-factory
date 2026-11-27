package skills

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
)

const (
	ControlDirectory             = "/var/lib/factory/skills"
	nativeSkillsControlDirectory = ControlDirectory
	nativeSkillsBun              = "/opt/factory/opencode/musl/bun"
	nativeSkillsInstaller        = "/opt/factory/opencode/server/install-skills.mjs"
)

func nativeSkillsCommand(ctx context.Context, data string) *exec.Cmd {
	command := procutil.OwnedCommand(ctx, nativeSkillsBun, nativeSkillsInstaller)
	command.Dir = "/"
	// No Project environment, Bun preload/options, or inherited credentials.
	command.Env = []string{"PATH=/usr/bin:/bin"}
	command.Stdin = strings.NewReader(data)
	return command
}

type nativeSkillsOutput struct{ bytes.Buffer }

func (output *nativeSkillsOutput) Write(data []byte) (int, error) {
	length := len(data)
	if remaining := 2000 - output.Len(); remaining > 0 {
		_, _ = output.Buffer.Write(data[:min(remaining, length)])
	}
	return length, nil
}

func runNativeSkills(ctx context.Context, data string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := nativeSkillsCommand(ctx, data)
	var output nativeSkillsOutput
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		// Also clean the owned group if the leader exited leaving pipe holders.
		procutil.StopAssignedProcess(command)
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return fmt.Errorf("install admitted skill packages: %w: %s", err, output.String())
	}
	return nil
}
