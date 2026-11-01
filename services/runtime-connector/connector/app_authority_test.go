package connector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChildAppPreservesFactoryAuthenticatedBrowserHost(t *testing.T) {
	for _, kind := range []string{"app", "agent"} {
		for _, authority := range []struct{ host, protocol string }{
			{"owned-app.runtime.localhost:58310", "http"},
			{"owned-app.preview.example.test", "https"},
			{"[::1]:58310", "http"},
		} {
			t.Run(kind+"/"+authority.host, func(t *testing.T) {
				publicHost := authority.host
				origin := authority.protocol + "://" + publicHost
				observed := make(chan *http.Request, 1)
				application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					observed <- r
					w.WriteHeader(http.StatusNoContent)
				}))
				defer application.Close()
				runtime := childRuntime{
					assignment: Assignment{Channels: []Channel{{Name: "owned", Kind: kind, Target: application.URL}}},
					httpClient: application.Client(),
				}
				runtime.handleHTTPRequest(context.Background(), Message{
					StreamID: "owned", Channel: "owned", Method: http.MethodOptions, Path: "/admin/auth/config",
					Headers: map[string]string{
						"origin": origin, "x-forwarded-host": publicHost, "x-forwarded-proto": authority.protocol,
						"host": "must-not-use-client-host.invalid",
					},
				})
				request := <-observed
				expectedHost := strings.TrimPrefix(application.URL, "http://")
				if kind == "app" {
					expectedHost = publicHost
				}
				if request.Host != expectedHost || request.Header.Get("Origin") != origin {
					t.Fatalf("browser authority changed: Host=%q Origin=%q, expected Host=%q", request.Host, request.Header.Get("Origin"), expectedHost)
				}
			})
		}
	}
}

func TestChildAppRejectsMalformedProxyAuthorityBeforeDispatch(t *testing.T) {
	for _, headers := range []map[string]string{
		{"x-forwarded-host": "user@other.invalid", "x-forwarded-proto": "http"},
		{"x-forwarded-host": "app.invalid/path", "x-forwarded-proto": "http"},
		{"x-forwarded-host": "app.invalid?target=other", "x-forwarded-proto": "http"},
		{"x-forwarded-host": "app.invalid#other", "x-forwarded-proto": "http"},
		{"x-forwarded-host": "app.invalid\r\ninjected: value", "x-forwarded-proto": "http"},
		{"x-forwarded-host": "app.invalid", "x-forwarded-proto": "file"},
		{"x-forwarded-host": "app.invalid"},
		{"x-forwarded-proto": "http"},
	} {
		t.Run(headers["x-forwarded-host"]+"/"+headers["x-forwarded-proto"], func(t *testing.T) {
			requests := 0
			runtime := childRuntime{
				assignment: Assignment{Channels: []Channel{{Name: "app", Kind: "app", Target: "http://127.0.0.1:1"}}},
				httpClient: &http.Client{Transport: recoveryRoundTripper(func(*http.Request) (*http.Response, error) {
					requests++
					return &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header), Body: http.NoBody}, nil
				})},
			}
			runtime.handleHTTPRequest(context.Background(), Message{
				StreamID: "owned", Channel: "app", Method: http.MethodOptions, Path: "/", Headers: headers,
			})
			if requests != 0 {
				t.Fatal("malformed App proxy authority reached the upstream service")
			}
		})
	}
}
