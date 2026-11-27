package writergate

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

// Gate owns only Work's writer admission, never an Actor/container lifecycle.
// PID1 remains available for transport while its Project peers are SIGSTOPped.
type Gate struct {
	operations sync.RWMutex
	spawns     sync.Mutex
	frozen     atomic.Bool
	refresh    func(context.Context) error
}

func NewGate(refresh func(context.Context) error) *Gate {
	return &Gate{refresh: refresh}
}

func (gate *Gate) Frozen() bool {
	return gate != nil && gate.frozen.Load()
}

func (gate *Gate) SetFrozen(frozen bool) {
	gate.frozen.Store(frozen)
}

func (gate *Gate) SetRefresh(refresh func(context.Context) error) {
	gate.refresh = refresh
}

// EnterOperation acquires a shared operation lock if writers are not fenced.
// When fenced is false, callers must invoke release when the operation ends.
func (gate *Gate) EnterOperation() (release func(), fenced bool) {
	gate.operations.RLock()
	if gate.frozen.Load() {
		gate.operations.RUnlock()
		return nil, true
	}
	return gate.operations.RUnlock, false
}

func (gate *Gate) Start(start func() error) error {
	if gate == nil {
		return start()
	}
	gate.spawns.Lock()
	defer gate.spawns.Unlock()
	if gate.frozen.Load() {
		return errors.New("native Source writers are fenced")
	}
	return start()
}

func (gate *Gate) Freeze(ctx context.Context) error {
	gate.operations.Lock()
	defer gate.operations.Unlock()
	gate.spawns.Lock()
	defer gate.spawns.Unlock()
	gate.frozen.Store(true)
	return FreezeNativeProjectWriters(ctx)
}

func (gate *Gate) Resume(ctx context.Context) error {
	gate.operations.Lock()
	defer gate.operations.Unlock()
	gate.spawns.Lock()
	defer gate.spawns.Unlock()
	if !gate.frozen.Load() || gate.refresh == nil {
		return errors.New("native writer continuation requires its frozen owner and current authority")
	}
	if err := gate.refresh(ctx); err != nil {
		return err
	}
	if err := ResumeNativeProjectWriters(); err != nil {
		return err
	}
	gate.frozen.Store(false)
	return nil
}
