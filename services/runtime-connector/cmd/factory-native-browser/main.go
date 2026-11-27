package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/connector"
)

func main() {
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "native Browser accepts only its fixed Factory bootstrap")
		os.Exit(1)
	}
	if connector.ProtectProcess() != nil {
		fmt.Fprintln(os.Stderr, "native Browser control process could not be protected")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := connector.RunNativeBrowserGateway(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
