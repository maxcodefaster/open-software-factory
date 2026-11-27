//go:build !linux

package connector

import (
	"context"
	"errors"
)

func RunSubstrateProject(context.Context) error {
	return errors.New("native Project execution requires Linux")
}
