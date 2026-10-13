package connector

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBrowserAuthorityRejectsExpiredOverlongChangedAndUnknownScope(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authority.json")
	for _, invalid := range []browserAuthority{
		{SessionID: "browser-proof", ExpiresAt: time.Now().Add(-time.Second)},
		{SessionID: "browser-proof", ExpiresAt: time.Now().Add(time.Minute)},
		{SessionID: "../other", ExpiresAt: time.Now().Add(time.Second)},
	} {
		content, _ := json.Marshal(invalid)
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readBrowserAuthority(path); err == nil {
			t.Fatal("invalid browser lease was accepted")
		}
	}
	if err := os.WriteFile(path, []byte(`{"sessionId":"browser-proof","expiresAt":"2099-01-01T00:00:00Z","command":"anything"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBrowserAuthority(path); err == nil {
		t.Fatal("unknown lease fields were accepted")
	}
}

func TestBrowserAuthorityEndsOnLeaseExpiryOrScopeReplacement(t *testing.T) {
	for _, replacement := range []bool{false, true} {
		t.Run(map[bool]string{false: "expiry", true: "scope replacement"}[replacement], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "authority.json")
			write := func(id string, duration time.Duration) {
				content, _ := json.Marshal(browserAuthority{SessionID: id, ExpiresAt: time.Now().Add(duration)})
				if err := os.WriteFile(path+".next", content, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(path+".next", path); err != nil {
					t.Fatal(err)
				}
			}
			write("browser-proof", 150*time.Millisecond)
			ctx, cancel, err := browserAuthorityContext(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			if replacement {
				write("different-browser", time.Second)
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("browser authority survived expiry or replacement")
			}
		})
	}
}

func TestBrowserAuthorityCanRenewOnlyTheSameLiveSession(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authority.json")
	write := func(duration time.Duration) {
		content, _ := json.Marshal(browserAuthority{SessionID: "browser-proof", ExpiresAt: time.Now().Add(duration)})
		if err := os.WriteFile(path+".next", content, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(path+".next", path); err != nil {
			t.Fatal(err)
		}
	}
	write(250 * time.Millisecond)
	ctx, cancel, err := browserAuthorityContext(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	write(800 * time.Millisecond)
	select {
	case <-ctx.Done():
		t.Fatal("live same-session renewal was rejected")
	case <-time.After(400 * time.Millisecond):
	}
	cancel()
	<-ctx.Done()
	write(time.Second)
	if ctx.Err() == nil {
		t.Fatal("renewal revived canceled execution authority")
	}
}
