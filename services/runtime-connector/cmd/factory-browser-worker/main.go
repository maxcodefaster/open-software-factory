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
		fmt.Fprintln(os.Stderr, "browser worker accepts no command arguments")
		os.Exit(1)
	}
	if err := connector.ProtectProcess(); err != nil {
		fmt.Fprintln(os.Stderr, "protect browser worker process failed")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := connector.RunBrowserWorker(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
