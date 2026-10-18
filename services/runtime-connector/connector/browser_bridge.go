package connector

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// Chrome's loopback HTTP proxy has one fixed Unix connection to the App proxy
// outside its network namespace. It cannot create a TCP connection to an App,
// the workspace daemon, Factory, or the public network.
func newBrowserLoopbackBridge(socket string) (*httputil.ReverseProxy, *browserHTTPTransport) {
	transport := newBrowserHTTPTransport(&http.Transport{
		// Proxy mode retains the absolute request URL across the Unix connection.
		Proxy: func(*http.Request) (*url.URL, error) {
			return &url.URL{Scheme: "http", Host: "factory-browser-unix.invalid"}, nil
		},
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", socket)
		},
		ResponseHeaderTimeout: 6 * time.Second,
		IdleConnTimeout:       15 * time.Second,
		MaxIdleConns:          8,
	}, 21*time.Second)
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(*httputil.ProxyRequest) {
			// The outer proxy validates the origin, then replaces its destination.
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "browser App connection unavailable", http.StatusServiceUnavailable)
		},
	}, transport
}
