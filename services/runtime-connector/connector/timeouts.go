package connector

import "time"

// Operational limits for the Runtime Connector. They are fixed in code and are
// not configurable at runtime; change them here and adjust the tests that name them.
const (
	// prebuildTimeout bounds a Project prebuild produced inside a Runtime attempt,
	// including image build, push and publication to Factory.
	prebuildTimeout = 12 * time.Minute
	// prebuildProduceTimeout bounds ProducePrebuild itself, which also runs
	// outside a Runtime attempt.
	prebuildProduceTimeout = 10 * time.Minute

	// dockerReadyTimeout bounds the wait for the private Docker daemon at startup.
	// dockerReadyPollInterval is the delay between `docker info` probes, and
	// dockerReadyAttempts caps probes so the count matches the deadline.
	dockerReadyTimeout      = 30 * time.Second
	dockerReadyPollInterval = 250 * time.Millisecond
	dockerReadyAttempts     = int(dockerReadyTimeout / dockerReadyPollInterval)

	// browserImagePullTimeout bounds acquisition of the pinned browser tools image.
	browserImagePullTimeout = 180 * time.Second
	// projectImagePullTimeout bounds acquisition of all Project registry images.
	projectImagePullTimeout = 180 * time.Second

	// channelReadinessTimeout is one shared window for every declared channel to
	// answer its health path after the child starts its processes.
	channelReadinessTimeout = 420 * time.Second

	// orderedRequestTimeout bounds observation of an ordered Agent request before
	// response headers. It does not bound model execution.
	orderedRequestTimeout = 60 * time.Second

	// gitOperationTimeout bounds local-only Git work in the Workspace checkout
	// (status, commit, personal Git actions).
	gitOperationTimeout = 45 * time.Second
	// gitRemoteTimeout bounds Git operations that talk to the forge (integration
	// fetch and push).
	gitRemoteTimeout = 3 * time.Minute
	// gitCloneTimeout bounds the initial Project checkout.
	gitCloneTimeout = 10 * time.Minute

	// browserOpenTimeout covers a cold Chrome launch plus navigation.
	// browserCallTimeout bounds every other fixed browser tool call.
	browserOpenTimeout = 25 * time.Second
	browserCallTimeout = 15 * time.Second

	// controlHandshakeTimeout bounds the WebSocket upgrade to Factory.
	controlHandshakeTimeout = 15 * time.Second
	// controlWriteTimeout bounds each control frame write.
	controlWriteTimeout = 15 * time.Second
	// controlPingInterval is how often the Connector pings Factory. A pong, ping
	// or message resets the read deadline, controlReadTimeout, so a half-open
	// socket fails after three missed intervals instead of blocking forever.
	controlPingInterval = 30 * time.Second
	controlReadTimeout  = 3 * controlPingInterval

	// controlReconnectMin and controlReconnectMax bound the exponential backoff
	// between control reconnect attempts. Each delay gets up to 50% jitter.
	controlReconnectMin = time.Second
	controlReconnectMax = 30 * time.Second

	// parentOperationQueueLimit caps queued Parent operations so a flood cannot
	// grow memory while a Git operation is running.
	parentOperationQueueLimit = 8
)
