package workspacefiles

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/repositoryurl"
	"golang.org/x/sys/unix"
)

// Initialization runs with trusted ownership privileges before exposing source.
// It neither evaluates repository hooks nor starts a Dev Container or Project code.
type Initialization struct {
	WorkspaceID   string `json:"workspaceId"`
	ProjectID     string `json:"projectId"`
	Revision      string `json:"revision"`
	RepositoryURL string `json:"repositoryUrl"`
	OriginURL     string `json:"originUrl"`
	Branch        string `json:"branch,omitempty"`
}

var sourceRevision = regexp.MustCompile(`^[a-f0-9]{40}([a-f0-9]{24})?$`)

type initializationIdentity struct {
	WorkspaceID string `json:"workspaceId"`
	ProjectID   string `json:"projectId"`
	Revision    string `json:"revision"`
	OriginURL   string `json:"originUrl"`
	Branch      string `json:"branch,omitempty"`
}

func sourceRepositoryURL(value string) bool {
	return repositoryurl.Valid(value)
}

// transientSourceError marks a connection failure that a short wait can resolve, for example
// while a new Pod's NetworkPolicy rules are still reaching its node.
type transientSourceError struct{ message string }

func (e *transientSourceError) Error() string { return e.message }

// retryTransientSource retries operation while it fails with a transient connection error,
// waiting between attempts, and gives up when the delays are exhausted or ctx ends.
func retryTransientSource(ctx context.Context, delays []time.Duration, operation func() error) error {
	for attempt := 0; ; attempt++ {
		err := operation()
		var transient *transientSourceError
		if err == nil || !errors.As(err, &transient) || attempt >= len(delays) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delays[attempt]):
		}
	}
}

var sourceConnectDelays = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 10 * time.Second, 10 * time.Second, 10 * time.Second}

func sourceTLSVerificationFailure(message string) bool {
	lower := strings.ToLower(message)
	for _, marker := range []string{"certificate", "cafile", "capath", "hostname", "host name", "subject name", "issuer", "trust", "unknown ca"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func sourceConnectionFailure(message string) string {
	lower := strings.ToLower(message)
	// A reset can accompany a permanent TLS, proxy or authority failure.
	// Those explicit failures always take precedence over transport symptoms.
	if sourceTLSVerificationFailure(message) {
		return ""
	}
	for _, permanent := range []string{
		"alert", "ssl_error_ssl",
		"authentication", "authorization", "username", "password", "denied", "forbidden", "unauthorized",
		"not allowed", "not authorized", "egress", "policy", "401", "403", "407", "503",
	} {
		if strings.Contains(lower, permanent) {
			return ""
		}
	}
	for _, category := range []string{"Could not resolve host", "Failed to connect"} {
		if strings.Contains(message, category) {
			return category
		}
	}
	// The native loopback proxy reports failed DNS/connect with CONNECT 500.
	// Retrying this unchanged clone read cannot bypass its egress/TLS authority.
	if strings.Contains(lower, "connect tunnel failed, response 500") {
		return "proxy connection unavailable"
	}
	// Linux ECONNRESET from libcurl/OpenSSL. Do not retry generic SSL errors,
	// SSL_ERROR_SSL or SSL_ERROR_SYSCALL with an unspecified/zero errno.
	if strings.Contains(lower, "connection reset by peer") ||
		strings.Contains(lower, "ssl_read: ssl_error_syscall, errno 104") {
		return "connection reset"
	}
	return ""
}

func initGit(ctx context.Context, directory string, args ...string) (string, error) {
	base := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.logAllRefUpdates=false", "-c", "safe.directory=" + directory}
	if directory != "" {
		base = append(base, "-C", directory)
	}
	command := exec.CommandContext(ctx, "git", append(base, args...)...)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
	// Transport only. Actor checkout needs its normal restricted proxy and CA;
	// never inherit Connector capabilities, Git configuration or Project grants.
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH"} {
		if value, ok := os.LookupEnv(name); ok {
			command.Env = append(command.Env, name+"="+value)
		}
	}
	// Only InitializeService can attach this transport. Scope the header to
	// that clone URL and subprocess; local Git, Actor initialization, hooks and
	// persisted repository/initialization configuration never receive it.
	if transport, ok := ctx.Value(serviceCloneTransportKey{}).(serviceCloneTransport); ok &&
		transport.authorization != "" && len(args) > 0 && args[0] == "clone" {
		command.Env = append(command.Env, "GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=http."+transport.repositoryURL+".extraHeader",
			"GIT_CONFIG_VALUE_0=Authorization: "+transport.authorization)
	}
	output, err := command.Output()
	if err != nil {
		if canceled := ctx.Err(); canceled != nil {
			return "", canceled
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			message := string(exit.Stderr)
			if sourceTLSVerificationFailure(message) {
				return "", errors.New("source checkout preparation failed: TLS verification")
			}
			if category := sourceConnectionFailure(message); category != "" {
				return "", &transientSourceError{"source checkout preparation failed: " + category}
			}
			for _, category := range []string{"Could not resolve host", "Failed to connect", "403", "503", "Permission denied", "dubious ownership", "RPC failed", "SSL", "not a git command", "not found"} {
				if strings.Contains(message, category) {
					failure := "source checkout preparation failed: " + category
					return "", errors.New(failure)
				}
			}
		}
		return "", errors.New("source checkout preparation failed")
	}
	return strings.TrimSpace(string(output)), nil
}

func preparedCheckout(ctx context.Context, directory, projectID string) bool {
	info, err := os.Lstat(filepath.Join(directory, ".git"))
	if err != nil || !info.IsDir() {
		return false
	}
	identity, err := initGit(ctx, directory, "config", "--local", "--get", "factory.repositoryIdentity")
	return err == nil && identity == projectID
}

func Initialize(ctx context.Context, parent string, input Initialization) error {
	return initialize(ctx, parent, input, 1000, 1000)
}

type serviceCloneTransportKey struct{}
type serviceCloneTransport struct {
	repositoryURL string
	authorization string
}

// InitializeService exposes the existing initializer to trusted Factory code
// running as the development user. The optional Basic credential is clone-only
// transport, not Source identity or permission to run Project code.
func InitializeService(ctx context.Context, parent string, input Initialization, gitAuthorization string) error {
	if os.Geteuid() != 1000 || os.Getegid() != 1000 {
		return errors.New("Source initialization requires UID/GID 1000")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if gitAuthorization != "" {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(gitAuthorization, "Basic "))
		if !strings.HasPrefix(gitAuthorization, "Basic ") || len(gitAuthorization) > 8192 || err != nil ||
			!strings.Contains(string(decoded), ":") || strings.ContainsAny(gitAuthorization+string(decoded), "\r\n\x00") ||
			!sourceRepositoryURL(input.RepositoryURL) ||
			(!strings.HasPrefix(input.RepositoryURL, "https://") && !strings.HasPrefix(input.RepositoryURL, "http://")) {
			return errors.New("Source initialization Git authorization is invalid")
		}
	}
	if !filepath.IsAbs(parent) || filepath.Clean(parent) != parent || parent == "/" {
		return errors.New("Source initialization requires an absolute private parent")
	}
	if err := os.Mkdir(parent, 0700); err != nil && !os.IsExist(err) {
		return errors.New("Source initialization private parent is unavailable")
	}
	var info unix.Stat_t
	if unix.Lstat(parent, &info) != nil || info.Mode&unix.S_IFMT != unix.S_IFDIR ||
		info.Uid != 1000 || info.Gid != 1000 || info.Mode&0077 != 0 {
		return errors.New("Source initialization requires its owned private parent")
	}
	ctx = context.WithValue(ctx, serviceCloneTransportKey{}, serviceCloneTransport{input.RepositoryURL, gitAuthorization})
	return initialize(ctx, parent, input, 1000, 1000)
}

// InitializeActor validates the private native namespace before publishing the
// canonical checkout with development UID 1000. It never transfers Source ownership.
func InitializeActor(ctx context.Context, parent string, input Initialization) error {
	if err := ValidateActorSourceIdentity(parent); err != nil {
		return err
	}
	// The existing initializer leaves its private staging identity after atomic
	// publication. Missing published Source is not permission to clone over a loss.
	if _, err := os.Lstat(filepath.Join(parent, "project")); os.IsNotExist(err) {
		staging := filepath.Join(parent, ".factory-source-init-"+input.WorkspaceID)
		if _, prior := os.Lstat(filepath.Join(staging, "identity.json")); prior == nil {
			if _, unpublished := os.Lstat(filepath.Join(staging, "checkout")); os.IsNotExist(unpublished) {
				return errors.New("original Actor Source is missing; reinitialization is refused")
			}
		}
	}
	return initialize(ctx, parent, input, 1000, 1000)
}

func ValidateActorSourceIdentity(parent string) error {
	uidMap, uidErr := os.ReadFile("/proc/self/uid_map")
	gidMap, gidErr := os.ReadFile("/proc/self/gid_map")
	// connector.sh enters RootlessKit's existing private user namespace. Its
	// root maps to the unprivileged Actor UID 1000, NOT to host/Actor root.
	if os.Geteuid() != 0 || os.Getegid() != 0 || uidErr != nil || gidErr != nil || !actorSourceIDMap(string(uidMap)) || !actorSourceIDMap(string(gidMap)) || parent != "/home/rootless/persist" {
		return errors.New("Actor Source requires its private RootlessKit identity and durable parent")
	}
	return nil
}

func actorSourceIDMap(value string) bool {
	fields := strings.Fields(value)
	return len(fields) == 6 && fields[0] == "0" && fields[1] == "1000" && fields[2] == "1" && fields[3] == "1" && fields[4] == "100000" && fields[5] == "65536"
}

func initialize(ctx context.Context, parent string, input Initialization, uid, gid int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsAbs(parent) || filepath.Clean(parent) != parent || !sourceIdentity.MatchString(input.WorkspaceID) ||
		!sourceIdentity.MatchString(input.ProjectID) || !sourceRevision.MatchString(input.Revision) ||
		!sourceRepositoryURL(input.RepositoryURL) || !sourceRepositoryURL(input.OriginURL) {
		return errors.New("invalid source initialization identity")
	}
	if input.Branch != "" {
		if _, err := initGit(ctx, "", "check-ref-format", "refs/heads/"+input.Branch); err != nil {
			return errors.New("invalid personal source branch")
		}
	}
	if err := os.Mkdir(parent, 0755); err != nil && !os.IsExist(err) {
		return errors.New("source parent could not be created")
	}
	parentInfo, err := os.Lstat(parent)
	if err != nil || !parentInfo.IsDir() {
		return errors.New("source parent is unavailable")
	}
	lockFD, err := unix.Open(filepath.Join(parent, ".factory-source-init-lock"), unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return errors.New("source initialization lock is unavailable")
	}
	lock := os.NewFile(uintptr(lockFD), "source-initialization-lock")
	defer lock.Close()
	for {
		err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	canonical := filepath.Join(parent, "project")
	if info, err := os.Lstat(canonical); err == nil {
		if !info.IsDir() || !preparedCheckout(ctx, canonical, input.ProjectID) {
			return errors.New("existing source does not match the Project")
		}
		return nil // Never reset, clean or re-checkout human/Agent work during recovery.
	} else if !os.IsNotExist(err) {
		return errors.New("source checkout is unavailable")
	}
	staging := filepath.Join(parent, ".factory-source-init-"+input.WorkspaceID)
	identity := initializationIdentity{input.WorkspaceID, input.ProjectID, input.Revision, input.OriginURL, input.Branch}
	if err := os.Mkdir(staging, 0700); err == nil {
		encoded, _ := json.Marshal(identity)
		if err := os.WriteFile(filepath.Join(staging, "identity.json"), encoded, 0600); err != nil {
			return err
		}
	} else if !os.IsExist(err) {
		return errors.New("source initialization staging is unavailable")
	}
	info, err := os.Lstat(staging)
	if err != nil || !info.IsDir() {
		return errors.New("source initialization staging is unsafe")
	}
	encoded, err := os.ReadFile(filepath.Join(staging, "identity.json"))
	var observed initializationIdentity
	if err != nil || json.Unmarshal(encoded, &observed) != nil || observed != identity {
		return errors.New("source initialization staging identity differs")
	}
	checkout := filepath.Join(staging, "checkout")
	if _, err := os.Lstat(checkout); err == nil {
		if !preparedCheckout(ctx, checkout, input.ProjectID) {
			// This path is private initializer staging, not the canonical checkout.
			// Its owner was verified before removing an interrupted clone.
			if err := os.RemoveAll(checkout); err != nil {
				return errors.New("partial source initialization could not be removed")
			}
		}
	} else if !os.IsNotExist(err) {
		return errors.New("source initialization checkout is unavailable")
	}
	if !preparedCheckout(ctx, checkout, input.ProjectID) {
		if err := retryTransientSource(ctx, sourceConnectDelays, func() error {
			_, err := initGit(ctx, "", "clone", "--no-checkout", "--no-hardlinks", "--", input.RepositoryURL, checkout)
			var transient *transientSourceError
			if errors.As(err, &transient) {
				// Git can leave a nonempty destination on transport failure.
				// Remove only this failed attempt's identity-verified private
				// staging, never the canonical checkout or another Source.
				if cleanup := os.RemoveAll(checkout); cleanup != nil {
					return errors.New("partial source initialization could not be removed")
				}
			}
			return err
		}); err != nil {
			return err
		}
		checkoutArgs := []string{"checkout", "--detach", input.Revision}
		if input.Branch != "" {
			// This is still private initializer staging, never a retained tree.
			checkoutArgs = []string{"checkout", "-B", input.Branch, input.Revision}
		}
		if _, err := initGit(ctx, checkout, checkoutArgs...); err != nil {
			return errors.New("source revision checkout failed")
		}
		if input.Branch != "" {
			if _, err := initGit(ctx, checkout, "branch", "--set-upstream-to=origin/"+input.Branch, input.Branch); err != nil {
				return errors.New("personal source upstream is unavailable")
			}
		}
		// Mark only a fully initialized checkout as recoverable after lost acknowledgement.
		if _, err := initGit(ctx, checkout, "remote", "set-url", "origin", input.OriginURL); err != nil {
			return errors.New("source origin configuration failed")
		}
		if _, err := initGit(ctx, checkout, "config", "--local", "factory.repositoryIdentity", input.ProjectID); err != nil {
			return errors.New("source identity configuration failed")
		}
	}
	head, err := initGit(ctx, checkout, "rev-parse", "HEAD")
	if err != nil || head != input.Revision {
		return errors.New("prepared source revision differs")
	}
	if err := filepath.WalkDir(checkout, func(name string, entry os.DirEntry, err error) error {
		if canceled := ctx.Err(); canceled != nil {
			return canceled
		}
		if err != nil {
			return err
		}
		return os.Lchown(name, uid, gid)
	}); err != nil {
		return errors.New("source checkout ownership could not be prepared")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Rename(checkout, canonical); err != nil {
		return errors.New("source checkout could not be published")
	}
	parentFD, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer parentFD.Close()
	return parentFD.Sync()
}
