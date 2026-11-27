package procutil

import "time"

// Operational limits for the Runtime Connector. They are fixed in code and are
// not configurable at runtime; change them here and adjust the tests that name them.
const (

	// ChannelReadinessTimeout is one shared window for every declared channel to
	// answer its health path after the child starts its processes.
	ChannelReadinessTimeout = 420 * time.Second

	// OrderedRequestTimeout bounds observation of an ordered Agent request before
	// response headers. It does not bound model execution.
	OrderedRequestTimeout = 60 * time.Second

	// GitOperationTimeout bounds local-only Git work in the Workspace checkout
	// (status, commit, personal Git actions).
	GitOperationTimeout = 45 * time.Second
	// GitRemoteTimeout bounds Git operations that talk to the forge (integration
	// fetch and push).
	GitRemoteTimeout = 3 * time.Minute
	// GitCloneTimeout bounds the initial Project checkout.
	GitCloneTimeout = 10 * time.Minute

	// BrowserOpenTimeout covers a cold Chrome launch plus navigation.
	// BrowserCallTimeout bounds every other fixed browser tool call.
	BrowserOpenTimeout = 25 * time.Second
	BrowserCallTimeout = 15 * time.Second

	// ControlHandshakeTimeout bounds the WebSocket upgrade to Factory.
	ControlHandshakeTimeout = 15 * time.Second
	// ControlWriteTimeout bounds each control frame write.
	ControlWriteTimeout = 15 * time.Second
	// Keep pings well inside the native private proxy's 30-second idle window,
	// leaving room for handshakes and scheduling delays. A pong, ping or message
	// still resets the original 90-second half-open read deadline.
	ControlPingInterval = 10 * time.Second
	ControlReadTimeout  = 90 * time.Second
	// ControlReadQueueLimit bounds received application frames during native
	// Project preparation. A full queue applies socket backpressure.
	ControlReadQueueLimit = 8

	// ControlReconnectMin and ControlReconnectMax bound the exponential backoff
	// between control reconnect attempts. Each delay gets up to 50% jitter.
	ControlReconnectMin = time.Second
	ControlReconnectMax = 30 * time.Second

	// ParentOperationQueueLimit caps queued Parent operations so a flood cannot
	// grow memory while a Git operation is running.
	ParentOperationQueueLimit = 8
)
