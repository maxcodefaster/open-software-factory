package connector

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

// OpenCode API 2 does not yet expose its published MCP registration routes.
// Its existing shell and image-read tools use this fixed client instead. The
// client never accepts an endpoint, credential, file path or generic MCP call.
func RunBuildBrowserClient(ctx context.Context, turnID string, input io.Reader, output io.Writer) error {
	return runBuildBrowserClient(ctx, turnID, os.Getenv("FACTORY_BUILD_BROWSER_URL"), os.Getenv("FACTORY_BUILD_BROWSER_TOKEN"), input, output)
}

func runBuildBrowserClient(ctx context.Context, turnID, endpoint, token string, input io.Reader, output io.Writer) error {
	if !identityPattern.MatchString(turnID) || len(turnID) != 36 {
		return errors.New("an exact Build turn identity is required")
	}
	target, err := url.Parse(endpoint)
	if err != nil || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" ||
		(target.Scheme != "https" && target.Scheme != "http") || token == "" || len(token) > 256 {
		return errors.New("Factory Build browser configuration is unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(input, 16385))
	if err != nil || len(raw) > 16384 {
		return errors.New("browser input exceeds its bound")
	}
	var call browserToolCall
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&call) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("one fixed browser call is required")
	}
	// The server and isolated worker validate the actual declared App and page.
	// This early check rejects unsupported tools before making an HTTP request.
	if call.Name == "browser_open" {
		var args struct {
			App string `json:"app"`
		}
		if json.Unmarshal(call.Arguments, &args) != nil || !channelPattern.MatchString(args.App) {
			return errors.New("a declared App name is required")
		}
		if _, err := resolveBrowserTool([]Channel{{Name: args.App, Kind: "app"}}, 0, call); err != nil {
			return err
		}
	} else if _, err := resolveBrowserTool(nil, 1, call); err != nil {
		return err
	}
	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		return err
	}
	id := hex.EncodeToString(identity[:])
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": call})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	target.Path += "/" + turnID
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return errors.New("browser request could not be prepared")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("browser inspection is unconfirmed; do not replay a UI mutation")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("browser requires the current authorized Build and declared App")
	}
	result, err := io.ReadAll(io.LimitReader(response.Body, (3<<20)+1))
	if err != nil || len(result) > 3<<20 {
		return errors.New("browser result exceeds its bound")
	}
	var rpc struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      string          `json:"id"`
		Result  json.RawMessage `json:"result"`
	}
	if json.Unmarshal(result, &rpc) != nil || rpc.JSONRPC != "2.0" || rpc.ID != id {
		return errors.New("browser result was not confirmed")
	}
	content, err := boundBrowserResult(call.Name, rpc.Result)
	if err != nil {
		return err
	}
	if content.IsError {
		for _, item := range content.Content {
			if item.Type == "text" {
				if _, err := fmt.Fprintln(output, item.Text); err != nil {
					return err
				}
			}
		}
		return errors.New("browser inspection failed; inspect the outcome before any new UI mutation")
	}
	var provenance struct {
		Context *browserInspectionContext `json:"structuredContent"`
	}
	if json.Unmarshal(rpc.Result, &provenance) != nil || provenance.Context == nil || provenance.Context.TurnID != turnID ||
		!identityPattern.MatchString(provenance.Context.SessionID) || !browserCommitPattern.MatchString(provenance.Context.HeadCommit) ||
		!channelPattern.MatchString(provenance.Context.App) {
		return errors.New("browser inspection context was not confirmed")
	}
	context := provenance.Context
	if _, err := fmt.Fprintf(output, "Factory observation: turn=%s App=%s checkout=%s modified=%t runtime=%s generation=%d observed=%s\n", context.TurnID, context.App, context.HeadCommit, context.WorkingTreeModified, context.AttemptID, context.Generation, context.ObservedAt); err != nil {
		return err
	}
	for _, item := range content.Content {
		if item.Type == "text" {
			if _, err := fmt.Fprintln(output, item.Text); err != nil {
				return err
			}
		} else {
			path := browserScreenshotDirectory(context.SessionID) + "/screenshot.jpg"
			if _, err := fmt.Fprintf(output, "Screenshot: %s\nRead this JPEG with your image-capable read tool.\n", path); err != nil {
				return err
			}
		}
	}
	return nil
}
