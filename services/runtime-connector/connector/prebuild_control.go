package connector

import (
	"context"
	"sync"
	"time"
)

// Read heartbeat/control frames throughout the one producer invocation. A lost
// socket reconnects transport only; it never restarts build or publication.
func servePrebuildControl(parent context.Context, assignment Assignment, token string, initial *controlConnection, produce func(context.Context) error) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	current := initial
	var lock sync.Mutex
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		connection := initial
		var backoff reconnectBackoff
		for {
			var message Message
			if err := connection.read(&message); err != nil {
				connection.close()
				for {
					timer := time.NewTimer(backoff.next())
					select {
					case <-ctx.Done():
						timer.Stop()
						return
					case <-timer.C:
					}
					next, err := dialControl(ctx, assignment, "parent", token)
					if err != nil {
						continue
					}
					if next.write(Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation, Channels: parentChannels(assignment)}) != nil || next.write(Message{Type: "status", Phase: "starting"}) != nil {
						next.close()
						continue
					}
					lock.Lock()
					if ctx.Err() != nil {
						lock.Unlock()
						next.close()
						return
					}
					current = next
					lock.Unlock()
					connection = next
					backoff.reset()
					break
				}
				continue
			}
			if message.Type == "stop" {
				connection.write(Message{Type: "status", Phase: "stopping"})
				cancel()
				return
			}
			if message.Type == "operation-request" {
				connection.write(Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "Project image producer does not accept interactive operations"})
			}
		}
	}()
	err := produce(ctx)
	cancel()
	lock.Lock()
	status := Message{Type: "status", Phase: "stopped"}
	if err != nil {
		status.Phase, status.Error = "failed", err.Error()
	}
	statusErr := current.write(status)
	current.close()
	lock.Unlock()
	<-joined
	// The producer can finish while the reader is reconnecting a lost socket.
	// Preserve its actual terminal outcome instead of silently abandoning it and
	// leaving Factory to record only the later execution deadline. Reconnect once
	// for this report, never for another invocation of the completed producer.
	if statusErr != nil && parent.Err() == nil {
		report, finish := context.WithTimeout(parent, controlHandshakeTimeout)
		defer finish()
		if next, dialErr := dialControl(report, assignment, "parent", token); dialErr == nil {
			defer next.close()
			stopReport := context.AfterFunc(report, func() { next.close() })
			defer stopReport()
			if next.write(Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation, Channels: parentChannels(assignment)}) == nil {
				next.write(status)
			}
		}
	}
	return err
}
