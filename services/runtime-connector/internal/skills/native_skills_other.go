//go:build !linux

package skills

import (
	"context"
	"errors"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func installNativeSkills(context.Context, protocol.Assignment, string) error {
	return errors.New("native skill installation requires Linux control")
}
