package connector

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type readinessTransport func(*http.Request) (*http.Response, error)

func (transport readinessTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func readinessResponse(request *http.Request, status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader("private health body")),
		Header:     make(http.Header),
		Request:    request,
	}
}

func TestAppReadinessDoesNotExhaustItsBudgetOnFastConnectionRefusals(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		assignment := validAssignment()
		assignment.Channels = []Channel{{Name: "app", Kind: "app", Target: "http://app.invalid", HealthPath: "/health"}}
		attempts := 0
		client := &http.Client{Transport: readinessTransport(func(request *http.Request) (*http.Response, error) {
			attempts++
			if time.Since(started) < 45*time.Second {
				return nil, errors.New("connection refused")
			}
			return readinessResponse(request, http.StatusOK), nil
		})}
		if err := waitForChannelsWithClient(context.Background(), assignment, nil, client); err != nil {
			t.Fatalf("still-starting App was killed before it became healthy: %v", err)
		}
		if time.Since(started) != 45*time.Second || attempts <= 120 {
			t.Fatalf("did not exercise the former attempt-count cutoff: elapsed=%v attempts=%d", time.Since(started), attempts)
		}
	})
}

func TestAppReadinessSharesOneBoundedWindowAcrossRequiredChannels(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		assignment := validAssignment()
		assignment.Channels = []Channel{
			{Name: "app", Kind: "app", Target: "http://app.invalid", HealthPath: "/health"},
			{Name: "forms", Kind: "app", Target: "http://forms.invalid", HealthPath: "/ready"},
		}
		client := &http.Client{Transport: readinessTransport(func(request *http.Request) (*http.Response, error) {
			status := http.StatusServiceUnavailable
			if request.URL.Host == "app.invalid" && time.Since(started) >= 400*time.Second {
				status = http.StatusOK
			}
			return readinessResponse(request, status), nil
		})}
		err := waitForChannelsWithClient(context.Background(), assignment, nil, client)
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), `channel "forms"`) ||
			!strings.Contains(err.Error(), "HTTP 503") || time.Since(started) != 420*time.Second {
			t.Fatalf("required Apps did not share one elapsed startup deadline: elapsed=%v err=%v", time.Since(started), err)
		}
		if strings.Contains(err.Error(), "private health body") || strings.Contains(err.Error(), ".invalid") {
			t.Fatalf("health failure leaked private response content or URL: %v", err)
		}
	})
}
