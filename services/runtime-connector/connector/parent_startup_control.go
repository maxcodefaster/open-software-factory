package connector

import (
	"context"
	"time"
)

// Only this caller replaces control. Preparation runs once with a cancellable
// Parent context and is joined before returning. Do not cancel that context on
// success: injection starts the long-lived Child with it.
// The assignment value is captured before preparation can update its fields.
//
// The transport's existing reader serves Source/Ping/Pong and keeps application
// frames in its bounded queue. No writer, browser or Stop operation is dispatched
// by startup; an exact Source drain only cancels preparation, leaving the queued
// request and live Source for the existing ready/failure owner to drain and ACK.
func withParentStartupControl(ctx context.Context, assignment Assignment, token string, control **controlConnection, prepare func(context.Context) error) (returnError error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if (*control).sourceDrainRequested() {
		return context.Canceled
	}
	prepareCtx, cancelPreparation := context.WithCancel(ctx)
	result := make(chan error, 1)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		result <- prepare(prepareCtx)
	}()
	defer func() {
		if returnError != nil {
			cancelPreparation()
		}
		<-joined
	}()
	finish := func(err error) error {
		if (*control).sourceDrainRequested() {
			cancelPreparation()
		}
		if err != nil {
			return err
		}
		return prepareCtx.Err()
	}
	var backoff reconnectBackoff
	for {
		select {
		case err := <-result:
			return finish(err)
		case <-ctx.Done():
			(*control).close()
			return ctx.Err()
		case <-(*control).sourceDrain:
			return context.Canceled
		case <-(*control).done:
		}
		if (*control).sourceDrainRequested() {
			return context.Canceled
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
			case <-(*control).sourceDrain:
				timer.Stop()
				return context.Canceled
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
			if (*control).sourceDrainRequested() {
				connected.close()
				return context.Canceled
			}
			*control = connected
			backoff.reset()
			break
		}
	}
}
