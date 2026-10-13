package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/connector"
)

func main() {
	assignmentPath := flag.String("assignment", "/factory/assignment/assignment.json", "assigned execution identity")
	commit := flag.String("commit", "", "exact committed prebuild recipe")
	platform := flag.String("platform", "", "linux/amd64 or linux/arm64")
	repository := flag.String("image-repository", "", "approved registry repository ending in the Project identity")
	configuration := flag.String("config", "", "committed Dev Container recipe relative to the checkout")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	assignment, err := connector.ReadAssignment(*assignmentPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Project prebuild requires a valid execution assignment")
		os.Exit(1)
	}
	result, err := connector.ProducePrebuild(ctx, assignment, connector.PrebuildRequest{Commit: *commit, Platform: *platform, ImageRepository: *repository, Configuration: *configuration})
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(1)
	}
}
