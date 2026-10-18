package connector

import (
	"net/http"
	"time"
)

// Cold App pages and their assets may take longer to produce headers. Only
// GET/HEAD use that allowance; writes retain their original header deadline.
// Both transports still use the fixed destination and current lease context.
type browserHTTPTransport struct {
	ordinary *http.Transport
	read     *http.Transport
}

func newBrowserHTTPTransport(ordinary *http.Transport, readDeadline time.Duration) *browserHTTPTransport {
	read := ordinary.Clone()
	read.ResponseHeaderTimeout = readDeadline
	return &browserHTTPTransport{ordinary: ordinary, read: read}
}

func (transport *browserHTTPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		return transport.read.RoundTrip(request)
	}
	return transport.ordinary.RoundTrip(request)
}

func (transport *browserHTTPTransport) CloseIdleConnections() {
	transport.ordinary.CloseIdleConnections()
	transport.read.CloseIdleConnections()
}
