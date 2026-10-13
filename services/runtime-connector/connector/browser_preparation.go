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
	once    sync.Once
	prepare func(context.Context) error
}

func prepareBrowserImage(ctx context.Context, prepare func(context.Context) error) *browserImagePreparation {
	ctx, cancel := context.WithCancel(ctx)
	return &browserImagePreparation{done: make(chan struct{}), ctx: ctx, cancel: cancel, prepare: prepare}
}

func (preparation *browserImagePreparation) ready() error {
	if preparation.ctx.Err() != nil {
		return errors.New("Browser tools preparation was stopped")
	}
	preparation.once.Do(func() {
		go func() {
			finish := startupPhase("browser-image")
			preparation.err = preparation.prepare(preparation.ctx)
			finish()
			close(preparation.done)
		}()
	})
	select {
	case <-preparation.done:
		if preparation.err != nil {
			return errors.New("Browser tools could not prepare the approved image; check registry connectivity and CA trust, then restart the Workspace")
		}
		return nil
	default:
		return errors.New("Browser tools are preparing; retry browser inspection after preparation completes")
	}
}

func (preparation *browserImagePreparation) stop() {
	preparation.cancel()
	// Unused tools have no worker to join. Closing them must not start a pull.
	preparation.once.Do(func() { close(preparation.done) })
	<-preparation.done
}
