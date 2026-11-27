package connector

import (
	"context"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/inputstop"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

func nativeWriterCallerIdentity() (writergate.Identity, error) {
	return writergate.CallerIdentity()
}

func executeNativeInputStop(ctx context.Context, input nativeInputStop, binary string) (nativeInputStopResult, error) {
	return inputstop.Execute(ctx, input, binary)
}
