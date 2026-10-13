package workspacefiles

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

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
}

var sourceRevision = regexp.MustCompile(`^[a-f0-9]{40}([a-f0-9]{24})?$`)

type initializationIdentity struct {
	WorkspaceID string `json:"workspaceId"`
	ProjectID   string `json:"projectId"`
	Revision    string `json:"revision"`
	OriginURL   string `json:"originUrl"`
}

func sourceRepositoryURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	return (parsed.Scheme == "https" && parsed.Host != "") ||
		(parsed.Scheme == "http" && (parsed.Hostname() == "host.orb.internal" || parsed.Hostname() == "localhost")) ||
		(parsed.Scheme == "file" && parsed.Host == "" && filepath.IsAbs(parsed.Path))
}

func initGit(ctx context.Context, directory string, args ...string) (string, error) {
	base := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.logAllRefUpdates=false", "-c", "safe.directory=" + directory}
	if directory != "" {
		base = append(base, "-C", directory)
	}
	command := exec.CommandContext(ctx, "git", append(base, args...)...)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
	output, err := command.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			message := string(exit.Stderr)
			for _, category := range []string{"Could not resolve host", "Failed to connect", "403", "503", "Permission denied", "dubious ownership", "RPC failed", "SSL", "not a git command", "not found"} {
				if strings.Contains(message, category) {
					return "", errors.New("source checkout preparation failed: " + category)
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
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsAbs(parent) || filepath.Clean(parent) != parent || !sourceIdentity.MatchString(input.WorkspaceID) ||
		!sourceIdentity.MatchString(input.ProjectID) || !sourceRevision.MatchString(input.Revision) ||
		!sourceRepositoryURL(input.RepositoryURL) || !sourceRepositoryURL(input.OriginURL) {
		return errors.New("invalid source initialization identity")
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
	identity := initializationIdentity{input.WorkspaceID, input.ProjectID, input.Revision, input.OriginURL}
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
		if _, err := initGit(ctx, "", "clone", "--no-checkout", "--no-hardlinks", "--", input.RepositoryURL, checkout); err != nil {
			return err
		}
		if _, err := initGit(ctx, checkout, "checkout", "--detach", input.Revision); err != nil {
			return errors.New("source revision checkout failed")
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
		return os.Lchown(name, 101000, 101000) // Envbox's exact 100000 + canonical development UID 1000.
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
