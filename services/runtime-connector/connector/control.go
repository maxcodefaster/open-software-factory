package connector

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type controlConnection struct {
	connection   *websocket.Conn
	readTimeout  time.Duration
	writeLock    sync.Mutex
	readOnce     sync.Once
	incoming     chan controlFrame
	sourceDrain  chan struct{}
	readerDone   chan struct{}
	closeOnce    sync.Once
	done         chan struct{}
	source       *parentSourceStreams
	sourceCtx    context.Context
	cancelSource context.CancelFunc
}

type controlFrame struct {
	message Message
	err     error
}

func dialControl(ctx context.Context, assignment Assignment, role string, token string) (*controlConnection, error) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+token)
	headers.Set("X-Factory-Runtime-Attempt", assignment.RuntimeAttemptID)
	headers.Set("X-Factory-Runtime-Generation", fmt.Sprint(assignment.Generation))
	headers.Set("X-Factory-Connector-Role", role)
	if uid := os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID"); uid != "" {
		headers.Set("X-Factory-Runtime-Actor-UID", uid)
	}
	tlsConfig, err := controlTLSConfig()
	if err != nil {
		return nil, err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: controlHandshakeTimeout,
		Subprotocols:     []string{ConnectorProtocol},
		Proxy:            http.ProxyFromEnvironment,
		TLSClientConfig:  tlsConfig,
	}
	connection, response, err := dialer.DialContext(ctx, assignment.ControlURL, headers)
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("connect to Factory: %w", err)
	}
	if connection.Subprotocol() != ConnectorProtocol {
		connection.Close()
		return nil, fmt.Errorf("Factory did not select %s", ConnectorProtocol)
	}
	connection.SetReadLimit(maxControlBytes)
	control := &controlConnection{connection: connection, done: make(chan struct{})}
	if role == "parent" && assignment.nativeSource != nil {
		control.source = &parentSourceStreams{handler: assignment.nativeSource}
		control.sourceCtx, control.cancelSource = context.WithCancel(ctx)
	}
	control.armReadDeadline(controlReadTimeout)
	go control.keepAlive(ctx, controlPingInterval)
	return control, nil
}

// Both Parent and Child use dialControl, including reconnects. Reopen the
// projected trust bundle for each handshake, rather than caching the first
// CA for the process lifetime. Keep public roots and hostname verification.
func controlTLSConfig() (*tls.Config, error) {
	var roots *x509.CertPool
	// The native profile explicitly supplies the combined public + MITM bundle
	// in SSL_CERT_FILE. Go caches SystemCertPool, including that file's old CA,
	// so reopen the authoritative bundle rather than retaining removed anchors.
	if path := os.Getenv("SSL_CERT_FILE"); path != "" {
		pem, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read configured trust bundle: %w", err)
		}
		roots = x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("invalid configured trust bundle")
		}
	} else {
		var err error
		roots, err = x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("read system trust: %w", err)
		}
	}
	if path := os.Getenv("FACTORY_CONNECTOR_CA_FILE"); path != "" {
		pem, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read Factory trust bundle: %w", err)
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("invalid Factory trust bundle")
		}
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, nil
}

// Every frame from Factory, including its pong replies to our pings, extends
// the read deadline. A socket that goes silent for controlReadTimeout is
// half-open and its blocked read fails so the caller can reconnect.
func (control *controlConnection) armReadDeadline(timeout time.Duration) {
	control.readTimeout = timeout
	extend := func() error {
		return control.connection.SetReadDeadline(time.Now().Add(timeout))
	}
	_ = extend()
	control.connection.SetPongHandler(func(string) error { return extend() })
	control.connection.SetPingHandler(func(data string) error {
		_ = extend()
		err := control.connection.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(controlWriteTimeout))
		if err == websocket.ErrCloseSent {
			return nil
		}
		return err
	})
}

// Parent can prepare images and hooks before its application read loop starts.
// One transport reader still has to process Ping/Pong frames during that work.
// Native Source is initialized before Parent bootstrap. Serve its authenticated
// streams here even while images and hooks are being prepared. Other application
// messages stay ordered and bounded; reading never dispatches an operation,
// restarts preparation or changes its admission.
func (control *controlConnection) startReader() {
	control.readOnce.Do(func() {
		control.incoming = make(chan controlFrame, controlReadQueueLimit)
		control.sourceDrain = make(chan struct{})
		control.readerDone = make(chan struct{})
		go func() {
			defer close(control.readerDone)
			defer control.close()
			for {
				select {
				case <-control.done:
					return
				default:
				}
				if control.readTimeout > 0 {
					_ = control.connection.SetReadDeadline(time.Now().Add(control.readTimeout))
				}
				var frame controlFrame
				frame.err = control.connection.ReadJSON(&frame.message)
				if frame.err == nil && control.source != nil {
					switch frame.message.Type {
					case "http-request":
						control.source.start(control.sourceCtx, control, frame.message)
						continue
					case "stream-close":
						control.source.close(frame.message.StreamID)
						continue
					}
				}
				if frame.err == nil && frame.message.Type == "operation-request" &&
					frame.message.Action == "source-drain" && frame.message.OperationID != "" && !control.sourceDrainRequested() {
					// Wake startup even if this frame must wait for queue space.
					// Do not consume, dispatch or acknowledge it: the existing
					// owner must drain only after preparation has joined.
					close(control.sourceDrain)
				}
				select {
				case control.incoming <- frame:
				case <-control.done:
					return
				}
				if frame.err != nil {
					return
				}
			}
		}()
	})
}

func (control *controlConnection) sourceDrainRequested() bool {
	select {
	case <-control.sourceDrain:
		return true
	default:
		return false
	}
}

// Preserve the socket's receive order, including complete frames received before
// EOF. A terminal frame is not an acknowledgement of an application operation.
func (control *controlConnection) read(message *Message) error {
	control.startReader()
	receive := func(frame controlFrame) error {
		*message = frame.message
		return frame.err
	}
	select {
	case frame := <-control.incoming:
		return receive(frame)
	default:
	}
	select {
	case frame := <-control.incoming:
		return receive(frame)
	case <-control.done:
		select {
		case frame := <-control.incoming:
			return receive(frame)
		default:
			return net.ErrClosed
		}
	}
}

// reconnectBackoff spaces control reconnect attempts with exponential growth
// and jitter so a restarting Factory is not hit by every Runtime at once.
type reconnectBackoff struct{ attempt int }

func (backoff *reconnectBackoff) next() time.Duration {
	delay := controlReconnectMin
	for step := 0; step < backoff.attempt && delay < controlReconnectMax; step++ {
		delay *= 2
	}
	delay = min(delay, controlReconnectMax)
	backoff.attempt++
	return delay + time.Duration(rand.Int64N(int64(delay/2)+1))
}

func (backoff *reconnectBackoff) reset() { backoff.attempt = 0 }

func (control *controlConnection) write(message Message) error {
	control.writeLock.Lock()
	defer control.writeLock.Unlock()
	// Close announces the lost transport before TCP Close finishes. A producer
	// waiting on done must not mistake a write in that gap for a terminal report.
	select {
	case <-control.done:
		return net.ErrClosed
	default:
	}
	control.startReader()
	if err := control.connection.SetWriteDeadline(time.Now().Add(controlWriteTimeout)); err != nil {
		return err
	}
	return control.connection.WriteJSON(message)
}

func (control *controlConnection) close() error {
	var err error
	control.closeOnce.Do(func() {
		close(control.done)
		if control.cancelSource != nil {
			control.cancelSource()
		}
		err = control.connection.Close()
	})
	return err
}

func (control *controlConnection) keepAlive(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-control.done:
			return
		case <-ticker.C:
			if err := control.connection.WriteControl(
				websocket.PingMessage,
				nil,
				time.Now().Add(controlWriteTimeout),
			); err != nil {
				control.close()
				return
			}
		}
	}
}
