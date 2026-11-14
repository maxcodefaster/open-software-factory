//go:build !linux

package connector

import "errors"

func RunNativeInputStopWorker() error {
	return errors.New("native input Stop requires Linux namespaces")
}
