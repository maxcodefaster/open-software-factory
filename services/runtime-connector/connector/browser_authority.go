package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"
)

const browserAuthorityPath = "/factory/browser/config/authority.json"

type browserAuthority struct {
	SessionID string    `json:"sessionId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func readBrowserAuthority(path string) (browserAuthority, error) {
	invalid := errors.New("browser execution authority is unavailable or expired")
	file, err := os.Open(path)
	if err != nil {
		return browserAuthority{}, invalid
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024 {
		return browserAuthority{}, invalid
	}
	content, err := io.ReadAll(io.LimitReader(file, 1025))
	if err != nil {
		return browserAuthority{}, invalid
	}
	var authority browserAuthority
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&authority) != nil || decoder.Decode(new(any)) != io.EOF ||
		!identityPattern.MatchString(authority.SessionID) || time.Until(authority.ExpiresAt) <= 0 ||
		time.Until(authority.ExpiresAt) > 30*time.Second {
		return browserAuthority{}, invalid
	}
	return authority, nil
}

// Both fixed containers enforce this independently of the Docker client and
// parent process. A lost controller cannot leave background page requests alive.
// The parent atomically replaces this ephemeral lease file, never a database log.
func browserAuthorityContext(parent context.Context, path string) (context.Context, context.CancelFunc, error) {
	authority, err := readBrowserAuthority(path)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	go func() {
		defer cancel()
		timer := time.NewTimer(time.Until(authority.ExpiresAt))
		defer timer.Stop()
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				return
			case <-ticker.C:
				current, err := readBrowserAuthority(path)
				if err != nil || current.SessionID != authority.SessionID {
					return
				}
				if !current.ExpiresAt.Equal(authority.ExpiresAt) {
					authority = current
					if !timer.Stop() {
						return
					}
					timer.Reset(time.Until(authority.ExpiresAt))
				}
			}
		}
	}()
	return ctx, cancel, nil
}
