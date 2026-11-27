//go:build !linux

package inputstop

import "errors"

func RunWorker() error {
	return errors.New("native input Stop requires Linux namespaces")
}
