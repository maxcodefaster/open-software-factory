package connector

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func waitForChannels(ctx context.Context, assignment Assignment, processes *processManager) error {
	return waitForChannelsWithClient(ctx, assignment, processes, &http.Client{Timeout: 2 * time.Second})
}

func waitForChannelsWithClient(ctx context.Context, assignment Assignment, processes *processManager, client *http.Client) error {
	for _, channel := range assignment.Channels {
		if channel.Kind == "ide" {
			// This child owns real PTYs. No editor lives in execution, and App
			// or Agent health must not gate its authenticated connection.
			return nil
		}
	}
	// A refused TCP connection is fast, not evidence that an App exhausted its
	// startup window. Share one elapsed lifecycle window across all required
	// channels; caller cancellation and real process failures still end it early.
	ctx, cancel := context.WithTimeout(ctx, channelReadinessTimeout)
	defer cancel()
	for _, channel := range assignment.Channels {
		healthURL := strings.TrimSuffix(channel.Target, "/") + channel.HealthPath
		lastFailure := "health endpoint has not responded"
		readinessFailure := func(cause error) error {
			detail := lastFailure
			if processes != nil {
				if output := processes.StartupDiagnostic(channel.Name, assignment); output != "" {
					detail += "; " + output
				}
			}
			if cause != nil {
				return fmt.Errorf("channel %q did not become ready: %s: %w", channel.Name, detail, cause)
			}
			return fmt.Errorf("channel %q did not become ready: %s", channel.Name, detail)
		}
		for {
			if processes != nil {
				if err := processes.StartupFailure(assignment); err != nil {
					return err
				}
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
			if err != nil {
				return fmt.Errorf("create health request for channel %q: %w", channel.Name, err)
			}
			authorizeAgentRequest(request, channel, assignment)
			response, err := client.Do(request)
			if err == nil {
				io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
				response.Body.Close()
				if response.StatusCode >= 200 && response.StatusCode < 400 {
					break
				}
				lastFailure = fmt.Sprintf("last health response was HTTP %d", response.StatusCode)
			} else {
				// Do not retain response bodies or a URL-bearing transport error.
				// Either may contain Project credentials.
				lastFailure = "health connection failed"
			}
			select {
			case <-ctx.Done():
				return readinessFailure(ctx.Err())
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	return nil
}
