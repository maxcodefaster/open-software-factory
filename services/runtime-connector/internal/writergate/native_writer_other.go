//go:build !linux

package writergate

import (
	"context"
	"errors"
)

func FreezeNativeProjectWriters(context.Context) error {
	return errors.New("native writer barrier requires Linux PID1")
}

func ResumeNativeProjectWriters() error {
	return errors.New("native writer barrier requires Linux PID1")
}
