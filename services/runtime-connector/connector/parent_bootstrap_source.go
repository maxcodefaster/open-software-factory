package connector

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func keepsParentStartupSource(assignment Assignment) bool {
	return assignment.nativeActorUID != "" && assignment.nativeRetainedSource && assignment.nativeSource != nil && assignment.PreserveWorkspace
}

func cleanupFailedParentStartup(assignment Assignment, failure error) error {
	// Retained native containers include private writable layers, not just named
	// volumes. Source drain will stop them before the original ROOTFS checkpoint;
	// deleting partial bootstrap containers here would silently discard their data.
	if keepsParentStartupSource(assignment) || errors.Is(failure, errDevcontainerNotStarted) {
		return failure
	}
	if err := cleanupAttempt(assignment); err != nil {
		return fmt.Errorf("%w; cleanup failed: %v", failure, err)
	}
	return failure
}

// Keep native retained Source and private Docker files alive after a bootstrap
// failure. No Project command, Git operation, browser, Child or hook is retried.
// Factory's existing Source drain/checkpoint and native Suspend still own Stop.
func retainParentStartupFailure(ctx context.Context, assignment Assignment, token string, control **controlConnection, failure error) error {
	reportParentStartupFailure(ctx, assignment, token, control, failure)
	if !keepsParentStartupSource(assignment) {
		return failure
	}
	streams := &parentSourceStreams{handler: assignment.nativeSource}
	fence := &parentSourceFence{}
	handle := fence.wrap(func(ctx context.Context, message Message) Message {
		if message.Action != "source-drain" {
			return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "startup failed; only retained Source checkpoint operations are available"}
		}
		return handleParentOperation(ctx, assignment, message)
	})
	operations := startParentOperations(ctx, handle)
	defer operations.stop()
	connectionContext, disconnect := browserConnectionContext(ctx)
	defer func() { disconnect() }()
	var backoff reconnectBackoff
	for {
		var message Message
		connection := *control
		cancelRead := context.AfterFunc(ctx, func() { connection.close() })
		err := connection.read(&message)
		cancelRead()
		if err != nil {
			disconnect()
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(backoff.next()):
			}
			reportParentStartupFailure(ctx, assignment, token, control, failure)
			connectionContext, disconnect = browserConnectionContext(ctx)
			continue
		}
		backoff.reset()
		switch message.Type {
		case "http-request":
			streams.start(connectionContext, *control, message)
		case "stream-close":
			streams.close(message.StreamID)
		case "operation-request":
			if !operations.submit(*control, message) {
				_ = (*control).write(Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "retained Source operation queue is full"})
			}
		case "stop":
			// Exiting here would destroy unsnapshotted gVisor filesystems. This
			// source-only owner waits for authenticated native lifecycle instead.
			_ = (*control).write(Message{Type: "status", Phase: "failed", Error: failure.Error()})
		}
	}
}
