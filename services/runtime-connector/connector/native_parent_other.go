//go:build !linux

package connector

import (
	"context"
	"errors"
	"io"
)

func RunSubstrateParent(context.Context) error {
	return errors.New("native Actor bootstrap requires Linux")
}

func reserveNativeDevcontainerLockfile(Assignment) error {
	return errors.New("native Dev Container lockfile ownership requires Linux")
}

func RunSubstrateSourcePreserve(string, string, io.Writer) error {
	return errors.New("retained native Source preservation requires Linux")
}

func RunSubstrateSourcePreserveReconciled(string, string, string, io.Writer) error {
	return errors.New("retained native Source preservation requires Linux")
}

func RunSubstrateSource(context.Context) error {
	return errors.New("native Source requires Linux")
}

func RunSourceHost(context.Context) error    { return errors.New("Source host requires Linux") }
func RunSourceService(context.Context) error { return errors.New("Source service requires Linux") }
func RunSourceMaterialize(string, string) error {
	return errors.New("Source materialization requires Linux")
}
func RunSubstrateSourceRestore(context.Context) error {
	return errors.New("Source restore requires Linux")
}
