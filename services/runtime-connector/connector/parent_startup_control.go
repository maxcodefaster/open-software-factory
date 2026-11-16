package connector

import (
	"context"
	"time"
)

// Only this caller replaces control. Preparation runs once against the Parent
// context and is joined before returning, including cancellation. Do not cancel
// that context on success: injection starts the long-lived Child with it.
// The assignment value is captured before preparation can update its fields.
//
// The transport's existing reader serves Source/Ping/Pong and keeps application
// frames in its bounded queue. No writer, browser or Stop operation is dispatched
// by startup; the existing ready/failure control owners retain those decisions.
func withParentStartupControl(ctx context.Context, assignment Assignment, token string, control **controlConnection, prepare func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	result := make(chan error, 1)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		result <- prepare(ctx)
	}()
	defer func() { <-joined }()
	finish := func(err error) error {
		if err != nil {
			return err
		}
		return ctx.Err()
	}
	var backoff reconnectBackoff
	for {
		select {
		case err := <-result:
			return finish(err)
		case <-ctx.Done():
			(*control).close()
			return ctx.Err()
		case <-(*control).done:
		}
		(*control).close()
		for {
			timer := time.NewTimer(backoff.next())
			select {
			case err := <-result:
				timer.Stop()
				return finish(err)
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			connected, err := dialControl(ctx, assignment, "parent", token)
			if err != nil {
				continue
			}
			cancelWrite := context.AfterFunc(ctx, func() { connected.close() })
			err = connected.write(Message{
				Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID,
				Generation: assignment.Generation, Channels: parentChannels(assignment),
			})
			if err == nil {
				err = connected.write(Message{Type: "status", Phase: "starting"})
			}
			cancelWrite()
			if err != nil || ctx.Err() != nil {
				connected.close()
				continue
			}
			*control = connected
			backoff.reset()
			break
		}
	}
}
