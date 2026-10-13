package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	flags := flag.NewFlagSet("factory-workspace-files", flag.ExitOnError)
	root := flags.String("root", "", "canonical source mount")
	assignment := flags.String("assignment", "", "private source-service assignment file")
	listen := flags.String("listen", "127.0.0.1:4600", "source-service listen address")
	initialize := flags.String("initialize", "", "private initialization assignment")
	parent := flags.String("parent", "", "durable source parent")
	flags.Parse(os.Args[1:])
	if *root == "" || *assignment == "" || flags.NArg() != 0 {
		fail("--root and --assignment are required")
	}
	input, err := os.Open(*assignment)
	if err != nil {
		fail("source assignment is unavailable")
	}
	var access workspacefiles.Access
	info, err := input.Stat()
	if err != nil || info.Size() > 4096 {
		input.Close()
		fail("invalid source assignment")
	}
	decoder := json.NewDecoder(io.LimitReader(input, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&access); err != nil {
		input.Close()
		fail("invalid source assignment")
	}
	if decoder.Decode(new(any)) != io.EOF {
		input.Close()
		fail("invalid source assignment")
	}
	input.Close()
	if *initialize != "" || *parent != "" {
		if *initialize == "" || *parent == "" || *root != *parent+"/project" {
			fail("invalid combined source initialization")
		}
		file, err := os.Open(*initialize)
		if err != nil {
			fail("source initialization assignment is unavailable")
		}
		var intent workspacefiles.Initialization
		info, err := file.Stat()
		if err != nil || info.Size() > 8192 {
			file.Close()
			fail("invalid source initialization assignment")
		}
		decoder := json.NewDecoder(io.LimitReader(file, 8192))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&intent); err != nil {
			file.Close()
			fail("invalid source initialization assignment")
		}
		if decoder.Decode(new(any)) != io.EOF || intent.WorkspaceID != access.WorkspaceID {
			file.Close()
			fail("source initialization identity differs")
		}
		file.Close()
		initializeCtx, finish := context.WithTimeout(ctx, 120*time.Second)
		err = workspacefiles.Initialize(initializeCtx, *parent, intent)
		finish()
		if err != nil {
			// Initialize returns bounded preparation errors, never Git output or clone credentials.
			fail("canonical source initialization failed: " + err.Error())
		}
		if err := workspacefiles.DropSourcePrivileges(); err != nil {
			fail("source privileges could not be removed")
		}
	} else if os.Geteuid() != 101000 {
		fail("source serving requires the mapped development user")
	}
	if ctx.Err() != nil {
		fail("source preparation was canceled")
	}
	source, err := workspacefiles.Open(*root)
	if err != nil {
		fail("canonical source is unavailable")
	}
	defer source.Close()
	service, err := workspacefiles.NewService(source, access)
	if err != nil {
		fail("invalid source service identity")
	}
	defer service.Revoke()
	server := &http.Server{Addr: *listen, Handler: service, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10}
	go func() {
		<-ctx.Done()
		service.Revoke()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fail("source service could not listen")
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
