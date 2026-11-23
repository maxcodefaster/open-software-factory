package connector

import (
	"context"
	"encoding/base64"
	"sync"
	"time"
)

// The pinned CLI resumes only the lifecycle commands it explicitly deferred.
// This one cancellable task is not a hook scheduler: no command is parsed,
// deduplicated or retried by Factory.
type nativeSetup struct {
	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	control *controlConnection
	state   string
	started string
	output  string
	exit    *int
}

func startNativeSetup(ctx context.Context, assignment Assignment, result devcontainerResult, control *controlConnection) *nativeSetup {
	if !result.lifecyclePending || ctx.Err() != nil || (control != nil && control.sourceDrainRequested()) {
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	setup := &nativeSetup{
		cancel: cancel, done: make(chan struct{}), state: "running",
		started: time.Now().UTC().Format(time.RFC3339Nano),
	}
	setup.connect(control)
	go func() {
		defer close(setup.done)
		finish := startupPhase("devcontainer-background-setup")
		_, err := runNativeLifecycle(ctx, assignment, result, false)
		finish()
		setup.mu.Lock()
		defer setup.mu.Unlock()
		code := 0
		setup.state, setup.output = "stopped", "Project setup completed."
		if ctx.Err() != nil {
			setup.output = "Project setup stopped."
			code = 130
		} else if err != nil {
			setup.state, setup.output, code = "failed", err.Error(), 1
		}
		setup.exit = &code
		setup.reportLocked()
	}()
	return setup
}

func (setup *nativeSetup) connect(control *controlConnection) {
	if setup == nil {
		return
	}
	setup.mu.Lock()
	defer setup.mu.Unlock()
	setup.control = control
	setup.reportLocked()
}

func (setup *nativeSetup) reportLocked() {
	if setup.control == nil {
		return
	}
	_ = setup.control.write(Message{
		Type: "process-state", Process: "setup", ProcessLabel: "Project setup",
		ProcessState: setup.state, StartedAt: setup.started, ExitCode: setup.exit,
	})
	if setup.output != "" {
		_ = setup.control.write(Message{
			Type: "process-output", Process: "setup",
			Data: base64.StdEncoding.EncodeToString([]byte(setup.output)),
		})
	}
}

func (setup *nativeSetup) stop() {
	if setup == nil {
		return
	}
	setup.cancel()
	<-setup.done
}
