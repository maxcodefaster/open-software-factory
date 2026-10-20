package connector

import (
	"context"
	"errors"
	"sync"
)

// One exact assigned image is prepared in this Workspace's private daemon.
// It is not editor readiness and does not create a browser execution session.
type browserImagePreparation struct {
	done    chan struct{}
	err     error
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	started bool
	turnID  string
	prepare func(context.Context) error
}

func prepareBrowserImage(ctx context.Context, prepare func(context.Context) error) *browserImagePreparation {
	ctx, cancel := context.WithCancel(ctx)
	return &browserImagePreparation{done: make(chan struct{}), ctx: ctx, cancel: cancel, prepare: prepare}
}

func (preparation *browserImagePreparation) ready(turnID string) error {
	preparation.mu.Lock()
	defer preparation.mu.Unlock()
	if preparation.ctx.Err() != nil {
		return errors.New("Browser tools preparation was stopped")
	}
	settled := false
	select {
	case <-preparation.done:
		settled = true
	default:
	}
	if !preparation.started || (settled && preparation.err != nil && preparation.turnID != turnID) {
		// Success is shared for this exact Runtime image. A failed download is
		// retained for its Turn, not a permanent failure of every later,
		// separately authorized implementation or review in the Workspace.
		if preparation.started {
			preparation.done = make(chan struct{})
		}
		preparation.started = true
		preparation.turnID = turnID
		preparation.err = nil
		done := preparation.done
		go func() {
			finish := startupPhase("browser-image")
			err := preparation.prepare(preparation.ctx)
			finish()
			preparation.mu.Lock()
			preparation.err = err
			close(done)
			preparation.mu.Unlock()
		}()
	}
	select {
	case <-preparation.done:
		if preparation.err != nil {
			return errors.New("Browser tools could not prepare the approved image; check Registry availability and approved access before retrying this work")
		}
		return nil
	default:
		return errors.New("Browser tools are preparing; retry browser inspection after preparation completes")
	}
}

func (preparation *browserImagePreparation) stop() {
	preparation.cancel()
	// Unused tools have no worker to join. Closing them must not start a pull.
	preparation.mu.Lock()
	if !preparation.started {
		preparation.started = true
		close(preparation.done)
	}
	done := preparation.done
	preparation.mu.Unlock()
	<-done
}
