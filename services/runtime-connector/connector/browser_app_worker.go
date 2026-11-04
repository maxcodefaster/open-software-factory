package connector

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"
)

// RunBrowserAppProxy runs only in the fixed proxy container joined to the exact
// admitted primary container's network namespace. No agent-supplied destination
// or listener options are accepted. The browser sees only its Unix socket.
func RunBrowserAppProxy(ctx context.Context) error {
	ctx, cancel, err := browserAuthorityContext(ctx, browserAuthorityPath)
	if err != nil {
		return err
	}
	defer cancel()
	channels, err := readBrowserApps()
	if err != nil {
		return err
	}
	proxy, err := newBrowserLoopbackAppProxy(ctx, channels)
	if err != nil {
		return err
	}
	defer proxy.close()
	observations, err := listenPrivateUnix(browserObservationSocket)
	if err != nil {
		return errors.New("browser observation socket unavailable")
	}
	defer observations.Close()
	defer os.Remove(browserObservationSocket)
	observer := &http.Server{
		Handler: http.HandlerFunc(proxy.serveObservations), ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout: 15 * time.Second, MaxHeaderBytes: 4096,
	}
	defer observer.Close()
	observerClosed := make(chan error, 1)
	go func() { observerClosed <- observer.Serve(observations) }()
	listener, err := listenPrivateUnix(browserSocketPath)
	if err != nil {
		return errors.New("browser App socket unavailable")
	}
	defer listener.Close()
	defer os.Remove(browserSocketPath)
	server := &http.Server{
		Handler: proxy, ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	closed := make(chan error, 1)
	go func() { closed <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		server.Close()
		<-closed
		return nil
	case <-closed:
		return errors.New("browser App proxy exited unexpectedly")
	case <-observerClosed:
		return errors.New("browser observation reader exited unexpectedly")
	}
}
