package connector

import (
	"net/http"
	"sync"
	"sync/atomic"
)

// The native controller owns this trusted development-user Source subprocess.
// Project containers and canonical checkout remain owned by Substrate.
type nativeSourceOwner struct {
	mu      sync.RWMutex
	service *nativeSourceService
	stop    func()
	ready   atomic.Bool
	epoch   atomic.Uint64
}

func (owner *nativeSourceOwner) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	owner.mu.RLock()
	service := owner.service
	ready := owner.ready.Load()
	owner.mu.RUnlock()
	if !ready || service == nil {
		http.Error(w, "Native Source is unavailable", http.StatusServiceUnavailable)
		return
	}
	service.ServeHTTP(w, r)
}

func (owner *nativeSourceOwner) close() {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	owner.ready.Store(false)
	if owner.stop != nil {
		owner.stop()
		owner.stop = nil
	}
}
