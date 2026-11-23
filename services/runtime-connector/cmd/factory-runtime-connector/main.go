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

// takeConnectorToken reads the inherited token and removes it from the process
// environment so no child process (Dev Container hooks, Git, process manager)
// inherits it. Children that need a token receive it explicitly.
func takeConnectorToken() string {
	token := os.Getenv("FACTORY_CONNECTOR_TOKEN")
	os.Unsetenv("FACTORY_CONNECTOR_TOKEN")
	return token
}

func main() {
	inheritedToken := takeConnectorToken()
	if err := connector.ProtectProcess(); err != nil {
		fail("protect Connector process: " + err.Error())
	}
	if len(os.Args) < 2 {
		fail("usage: factory-runtime-connector <parent|child>")
	}
	if os.Args[1] == "opencode-manifest" {
		if len(os.Args) != 2 {
			fail("OpenCode manifest accepts no arguments")
		}
		manifest, err := connector.OpenCodeArtifactsManifest(connector.OpenCodeArtifactsRoot)
		if err != nil {
			fail("OpenCode artifact manifest is unavailable")
		}
		if _, err := os.Stdout.Write(manifest); err != nil {
			fail("OpenCode artifact manifest output failed")
		}
		return
	}
	if os.Args[1] == "opencode-verify" {
		if len(os.Args) != 4 || os.Args[2] != "--libc" || (os.Args[3] != "glibc" && os.Args[3] != "musl") {
			fail("OpenCode verification requires --libc glibc or musl")
		}
		manifest, err := io.ReadAll(io.LimitReader(os.Stdin, connector.OpenCodeArtifactsManifestMaxBytes+1))
		if err != nil || len(manifest) > connector.OpenCodeArtifactsManifestMaxBytes ||
			connector.VerifyOpenCodeArtifacts(connector.OpenCodeArtifactsRoot, manifest, os.Args[3]) != nil {
			fail("OpenCode artifacts do not match the expected manifest")
		}
		return
	}
	if os.Args[1] == "opencode-reset" {
		if len(os.Args) != 2 {
			fail("OpenCode reset accepts no arguments")
		}
		if err := connector.ResetOpenCodeArtifacts(connector.OpenCodeArtifactsRoot); err != nil {
			fail("OpenCode artifact reset failed")
		}
		return
	}
	if os.Args[1] == "native-input-stop-worker" {
		if len(os.Args) != 2 {
			fail("native input Stop worker accepts only its fixed stdin assignment")
		}
		if err := connector.RunNativeInputStopWorker(); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "native-bootstrap-mode" {
		if len(os.Args) != 2 {
			fail("native cold mode accepts no arguments")
		}
		if err := connector.RunSubstrateBootstrapMode(os.Stdout); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "native-parent" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.RunSubstrateParent(ctx); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "native-source" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.RunSubstrateSource(ctx); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "source-host" || os.Args[1] == "source-service" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		var err error
		if os.Args[1] == "source-host" {
			err = connector.RunSourceHost(ctx)
		} else {
			err = connector.RunSourceService(ctx)
		}
		if err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "native-source-restore" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.RunSubstrateSourceRestore(ctx); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "source-materialize" {
		if len(os.Args) != 4 {
			fail("source-materialize requires confirmed bundle and private destination")
		}
		if err := connector.RunSourceMaterialize(os.Args[2], os.Args[3]); err != nil {
			fail(err.Error())
		}
		return
	}
	if os.Args[1] == "source-initialize" {
		if len(os.Args) != 2 {
			fail("source-initialize accepts only its fixed stdin assignment")
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		if err := connector.RunSourceInitialize(ctx, os.Stdin); err != nil {
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
	if os.Args[1] != "parent" && os.Args[1] != "child" {
		fail("mode must be parent or child")
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
	token := inheritedToken
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
