package writergate

import (
	"context"
	"errors"
	"testing"
)

func TestNativeWriterGateNeverReopensAfterUnconfirmedFreezeOrRevocation(t *testing.T) {
	if err := (*Gate)(nil).Start(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	gate := &Gate{}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := gate.Freeze(ctx); err == nil {
		t.Fatal("ordinary test process confirmed a native freeze")
	}
	started := false
	if err := gate.Start(func() error { started = true; return nil }); err == nil || started {
		t.Fatal("unconfirmed freeze allowed a new Project writer")
	}
	revoked := errors.New("current authority revoked")
	gate.SetRefresh(func(context.Context) error { return revoked })
	if err := gate.Resume(t.Context()); !errors.Is(err, revoked) || !gate.Frozen() {
		t.Fatal("revocation resumed native writers")
	}
}
