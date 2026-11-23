//go:build !linux

package connector

import (
	"strings"
	"testing"
)

func TestSourceInitializeRequiresLinux(t *testing.T) {
	if err := RunSourceInitialize(t.Context(), strings.NewReader(`{}`)); err == nil ||
		err.Error() != "Source initialization requires Linux" {
		t.Fatal("unsupported Source initializer did not report its Linux requirement")
	}
}
