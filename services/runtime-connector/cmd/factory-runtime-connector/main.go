package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/connector"
)

func main() {
	if err := connector.ProtectProcess(); err != nil {
		fail("protect Connector process: " + err.Error())
	}
	if len(os.Args) < 2 {
		fail("usage: factory-runtime-connector <parent|child>")
	}
	if os.Args[1] == "prepared-control" {
		flags := flag.NewFlagSet("prepared-control", flag.ExitOnError)
		action := flags.String("action", "", "fixed private prepared child operation")
		if err := flags.Parse(os.Args[2:]); err != nil {
			fail(err.Error())
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.ControlPreparedChild(ctx, *action, os.Stdin, os.Stdout); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "browser-client" {
		if len(os.Args) != 3 {
			fail("usage: factory-runtime-connector browser-client <Build turn ID>; one fixed JSON tool call on stdin")
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.RunBuildBrowserClient(ctx, os.Args[2], os.Stdin, os.Stdout); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "reserve" {
		flags := flag.NewFlagSet("reserve", flag.ExitOnError)
		slot := flags.String("slot", "", "path to the clean execution slot identity")
		activation := flags.String("activation", "", "fixed private activation path")
		if err := flags.Parse(os.Args[2:]); err != nil {
			fail(err.Error())
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.RunReserve(ctx, *slot, *activation); err != nil {
			fail(err.Error())
		}
		return
	}
	flags := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	assignmentPath := flags.String("assignment", "", "path to the runtime assignment")
	tokenPath := flags.String("token-file", "", "path to a short-lived Factory connector token")
	childTokenPath := flags.String("child-token-file", "", "path to a short-lived child connector token")
	tokenStdin := flags.Bool("token-stdin", false, "read a short-lived Factory connector token from stdin")
	if err := flags.Parse(os.Args[2:]); err != nil {
		fail(err.Error())
	}
	if *assignmentPath == "" {
		fail("--assignment is required")
	}
	assignment, err := connector.ReadAssignment(*assignmentPath)
	if err != nil {
		fail(err.Error())
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if os.Args[1] == "prepared-child" {
		if *tokenPath != "" || *childTokenPath != "" || *tokenStdin || os.Getenv("FACTORY_CONNECTOR_TOKEN") != "" {
			fail("prepared Project processes cannot read Runtime credentials")
		}
		if err := connector.RunPreparedChild(ctx, assignment); err != nil {
			fail(err.Error())
		}
		return
	}
	token := os.Getenv("FACTORY_CONNECTOR_TOKEN")
	if *tokenPath != "" {
		content, readErr := os.ReadFile(*tokenPath)
		if readErr != nil {
			fail("read connector token: " + readErr.Error())
		}
		token = string(content)
		if removeErr := os.Remove(*tokenPath); removeErr != nil {
			fail("remove connector token: " + removeErr.Error())
		}
	}
	if *tokenStdin {
		content, readErr := io.ReadAll(io.LimitReader(os.Stdin, 2*1024*1024+1))
		if readErr != nil {
			fail("read connector token: " + readErr.Error())
		}
		var credentials struct {
			Token       string            `json:"token"`
			Environment map[string]string `json:"environment"`
		}
		if len(content) > 2*1024*1024 || json.Unmarshal(content, &credentials) != nil || credentials.Token == "" {
			fail("Invalid Connector child credentials")
		}
		if err := connector.ValidateRuntimeValues(credentials.Environment); err != nil {
			fail(err.Error())
		}
		token = credentials.Token
		assignment.RuntimeEnvironment = credentials.Environment
	}
	childToken := ""
	if *childTokenPath != "" {
		content, readErr := os.ReadFile(*childTokenPath)
		if readErr != nil {
			fail("read child connector token: " + readErr.Error())
		}
		childToken = strings.TrimSpace(string(content))
	}
	switch os.Args[1] {
	case "child":
		err = connector.RunChild(ctx, assignment, token)
	case "parent":
		err = connector.RunParent(ctx, assignment, token, childToken)
	default:
		fail("mode must be parent or child")
	}
	if err != nil {
		fail(err.Error())
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
