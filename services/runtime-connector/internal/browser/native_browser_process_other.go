//go:build !linux

package browser

import (
	"errors"
	"os/exec"
)

func prepareNativeBrowserProcess(_ *exec.Cmd) error {
	return errors.New("native Browser execution requires Linux")
}

func restrictNativeBrowserWorker() error {
	return errors.New("native Browser execution requires Linux")
}

func protectNativeBrowserDirectory(_ string) error {
	return errors.New("native Browser execution requires Linux")
}
