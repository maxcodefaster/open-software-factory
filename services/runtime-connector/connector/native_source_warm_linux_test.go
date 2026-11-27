package connector

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNativeSourceOwnerServesOnlyItsReadyService(t *testing.T) {
	var calls int
	request := httptest.NewRequest(http.MethodPost, "/v1/workspaces/owned/stat", nil)
	service := &nativeSourceService{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r != request {
			t.Error("Source wrapper replaced its authenticated request")
		}
		w.Header().Set("X-Owned-Source", "unchanged")
		w.WriteHeader(http.StatusAccepted)
	})}
	for _, scenario := range []struct {
		name    string
		service *nativeSourceService
		ready   bool
		status  int
	}{
		{"missing-service", nil, true, http.StatusServiceUnavailable},
		{"not-ready", service, false, http.StatusServiceUnavailable},
		{"ready", service, true, http.StatusAccepted},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			owner := &nativeSourceOwner{service: scenario.service}
			owner.ready.Store(scenario.ready)
			owner.epoch.Store(7)
			response := httptest.NewRecorder()
			owner.ServeHTTP(response, request)
			if response.Code != scenario.status || owner.epoch.Load() != 7 {
				t.Fatalf("Source wrapper changed readiness/epoch: status=%d epoch=%d", response.Code, owner.epoch.Load())
			}
			if scenario.status == http.StatusAccepted && response.Header().Get("X-Owned-Source") != "unchanged" {
				t.Fatal("Source wrapper discarded the service response")
			}
			if scenario.status == http.StatusServiceUnavailable && response.Body.String() != "Native Source is unavailable\n" {
				t.Fatal("unavailable Source still advertises an obsolete renewal")
			}
		})
	}
	if calls != 1 {
		t.Fatal("Source wrapper dispatched without its ready service")
	}
}

func TestNativeSourceOwnerCloseRevokesReadinessAndStopsOnlyOnce(t *testing.T) {
	var stops int
	service := &nativeSourceService{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("closed Source owner dispatched another request")
	})}
	owner := &nativeSourceOwner{service: service}
	owner.ready.Store(true)
	owner.epoch.Store(7)
	owner.stop = func() {
		stops++
		if owner.ready.Load() {
			t.Error("Source was still ready when its subprocess was stopped")
		}
	}
	owner.close()
	owner.close()
	if stops != 1 || owner.stop != nil || owner.ready.Load() || owner.epoch.Load() != 7 || owner.service != service {
		t.Fatal("Source close replaced its identity or stopped the subprocess more than once")
	}
	response := httptest.NewRecorder()
	owner.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("closed Source owner remained available")
	}
}
