package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

// RunSourceInitialize is a trusted, one-shot caller of the existing Source
// initializer, not an Actor or Source-service lifecycle operation.
func RunSourceInitialize(ctx context.Context, input io.Reader) error {
	if os.Geteuid() != 1000 || os.Getegid() != 1000 {
		return errors.New("Source initialization requires UID/GID 1000")
	}
	const maxBytes = 64 << 10
	data, err := io.ReadAll(io.LimitReader(input, maxBytes+1))
	if err != nil || len(data) > maxBytes {
		return errors.New("Source initialization input is invalid")
	}
	var assignment *struct {
		Root             string                         `json:"root"`
		Initialization   *workspacefiles.Initialization `json:"initialization"`
		GitAuthorization string                         `json:"gitAuthorization,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&assignment) != nil || decoder.Decode(new(any)) != io.EOF ||
		assignment == nil || assignment.Root == "" || assignment.Initialization == nil {
		return errors.New("Source initialization input is invalid")
	}
	return workspacefiles.InitializeService(ctx, assignment.Root, *assignment.Initialization, assignment.GitAuthorization)
}
