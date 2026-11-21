package connector

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/jpeg"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const browserSocketPath = "/factory/browser/app.sock"
const browserAppsPath = "/factory/browser/config/apps.json"
const browserMCPVersion = "1.13.0"

// RunBrowserWorker is the fixed entrypoint of the isolated browser container.
// It has no checkout, credentials, Docker socket or external network interface.
// Its stdio is internal to the parent Connector, never an exposed runtime channel.
func RunBrowserWorker(ctx context.Context) error {
	ctx, cancel, err := browserAuthorityContext(ctx, browserAuthorityPath)
	if err != nil {
		return err
	}
	defer cancel()
	channels, err := readBrowserApps()
	if err != nil {
		return err
	}
	arguments, err := browserWorkerArguments(channels)
	if err != nil {
		return err
	}
	bridge, transport := newBrowserLoopbackBridge(browserSocketPath)
	defer transport.CloseIdleConnections()
	listener, err := net.Listen("tcp", "127.0.0.1:3128")
	if err != nil {
		return errors.New("browser loopback bridge unavailable")
	}
	server := &http.Server{
		Handler: bridge, ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	defer server.Close()
	go server.Serve(listener)
	command := exec.Command("/usr/local/bin/node", arguments...)
	// Do not inherit the parent process environment. In particular, never pass
	// Factory, model provider, forge, proxy or connector credentials to upstream.
	command.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp",
		"XDG_CONFIG_HOME=/tmp/config", "XDG_CACHE_HOME=/tmp/cache", "CI=1",
		"CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1", "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1",
	}
	output := &browserScreenshotOutput{writer: os.Stdout, cancel: cancel}
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, output, os.Stderr
	PrepareAssignedProcess(command)
	if err := command.Start(); err != nil {
		return errors.New("pinned browser tools failed to start")
	}
	defer StopAssignedProcess(command)
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	select {
	case err := <-finished:
		if err != nil || len(output.pending) != 0 {
			return errors.New("pinned browser tools exited unexpectedly")
		}
		return nil
	case <-ctx.Done():
		server.Close()
		TerminateAssignedProcess(command)
		select {
		case <-finished:
		case <-time.After(6 * time.Second):
			StopAssignedProcess(command)
			<-finished
		}
		return nil
	}
}

// Chromium's fast JPEG encoder emits separate baseline component scans. Some
// model image readers render those otherwise valid JPEGs as green stripes.
// Re-encode only inline screenshots with Go's interleaved baseline encoder.
// Keep the existing JPEG quality, dimensions, media type and MCP envelope.
func normalizeBrowserScreenshot(line []byte) ([]byte, error) {
	var reply map[string]json.RawMessage
	if json.Unmarshal(line, &reply) != nil {
		return line, nil
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(reply["result"], &result) != nil {
		return line, nil
	}
	var content []map[string]json.RawMessage
	if json.Unmarshal(result["content"], &content) != nil {
		return line, nil
	}
	changed := false
	for _, item := range content {
		var kind, mediaType, data string
		_ = json.Unmarshal(item["type"], &kind)
		_ = json.Unmarshal(item["mimeType"], &mediaType)
		if kind != "image" || mediaType != "image/jpeg" {
			continue
		}
		if changed || json.Unmarshal(item["data"], &data) != nil || len(data) > base64.StdEncoding.EncodedLen(1<<20) {
			return nil, errors.New("browser screenshot exceeds its image bound")
		}
		decoded, err := base64.StdEncoding.DecodeString(data)
		if err != nil || len(decoded) > 1<<20 {
			return nil, errors.New("browser screenshot encoding is invalid")
		}
		config, err := jpeg.DecodeConfig(bytes.NewReader(decoded))
		if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 1280 || config.Height > 720 {
			return nil, errors.New("browser screenshot dimensions are invalid")
		}
		image, err := jpeg.Decode(bytes.NewReader(decoded))
		if err != nil {
			return nil, errors.New("browser screenshot JPEG is invalid")
		}
		var encoded bytes.Buffer
		if jpeg.Encode(&encoded, image, &jpeg.Options{Quality: 75}) != nil || encoded.Len() > 1<<20 {
			return nil, errors.New("browser screenshot could not be normalized within its bound")
		}
		item["data"], _ = json.Marshal(base64.StdEncoding.EncodeToString(encoded.Bytes()))
		changed = true
	}
	if !changed {
		return line, nil
	}
	result["content"], _ = json.Marshal(content)
	reply["result"], _ = json.Marshal(result)
	return json.Marshal(reply)
}

type browserScreenshotOutput struct {
	writer  io.Writer
	cancel  context.CancelFunc
	pending []byte
}

func (output *browserScreenshotOutput) Write(data []byte) (size int, err error) {
	defer func() {
		if err != nil && output.cancel != nil {
			output.cancel()
		}
	}()
	size = len(data)
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		part := data
		if end >= 0 {
			part = data[:end]
		}
		if len(output.pending)+len(part) > 3<<20 {
			return 0, errors.New("browser MCP output exceeds its bound")
		}
		output.pending = append(output.pending, part...)
		if end < 0 {
			break
		}
		line, err := normalizeBrowserScreenshot(output.pending)
		if err != nil {
			return 0, err
		}
		framed := append(line, '\n')
		if written, err := output.writer.Write(framed); err != nil {
			return 0, err
		} else if written != len(framed) {
			return 0, io.ErrShortWrite
		}
		output.pending = output.pending[:0]
		data = data[end+1:]
	}
	return size, nil
}

func readBrowserApps() ([]Channel, error) {
	file, err := os.Open(browserAppsPath)
	if err != nil {
		return nil, errors.New("browser App assignment unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return nil, errors.New("browser App assignment exceeds its bound")
	}
	var channels []Channel
	decoder := json.NewDecoder(io.LimitReader(file, 16385))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&channels); err != nil {
		return nil, errors.New("invalid browser App assignment")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid browser App assignment trailer")
	}
	if _, err := browserWorkerArguments(channels); err != nil {
		return nil, err
	}
	return channels, nil
}

func browserWorkerArguments(channels []Channel) ([]string, error) {
	if len(channels) == 0 || len(channels) > 8 {
		return nil, errors.New("browser requires between one and eight declared Apps")
	}
	arguments := []string{
		"/opt/factory/browser-mcp/entrypoint.js",
		"--isolated", "--headless", "--executable-path=/opt/factory/chromium",
		"--proxy-server=http://127.0.0.1:3128", "--viewport=1280x720",
		"--chrome-arg=--proxy-bypass-list=<-loopback>", "--chrome-arg=--disable-quic",
		"--chrome-arg=--no-sandbox", "--chrome-arg=--disable-dev-shm-usage",
		"--no-usage-statistics", "--no-performance-crux", "--no-source-maps",
		"--no-javascript-evaluation", "--no-category-performance", "--no-category-memory",
		"--no-category-extensions", "--no-category-experimental-webmcp", "--no-category-experimental-third-party",
		"--no-category-pwa", "--no-category-network",
		"--experimental-structured-content",
		"--experimental-screencast", "--experimental-ffmpeg-path=/usr/local/bin/factory-recording-encoder",
		"--experimental-screencast-fps=15",
		"--screenshot-format=jpeg", "--screenshot-quality=75",
		"--screenshot-max-width=1280", "--screenshot-max-height=720",
	}
	seen := make(map[string]bool)
	for _, channel := range channels {
		if channel.Kind != "app" || !channelPattern.MatchString(channel.Name) ||
			validateTarget(channel.Target) != nil || seen[channel.Name] {
			return nil, errors.New("browser accepts only unique declared App channels")
		}
		seen[channel.Name] = true
		arguments = append(arguments, "--allowed-url-pattern=http://"+channel.Name+".factory.invalid/*")
		arguments = append(arguments, "--allowed-url-pattern="+strings.TrimSuffix(channel.Target, "/")+"/*")
	}
	return arguments, nil
}
