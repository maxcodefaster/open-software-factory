package connector

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
)

const browserRecordingPath = "/tmp/factory-review.webm"
const browserRecordingLimit = 96 << 20
const browserRecordingChunk = 48 << 10

// Encoder position, not wall time: the upstream recorder can omit startup or
// unchanged frames. Only this bounded numeric observation leaves the container.
func (manager *browserRuntimeManager) recordingPosition(ctx context.Context, runtime *browserRuntime) *int64 {
	if runtime.recordingStarted.IsZero() || !runtime.recordingEnded.IsZero() {
		return nil
	}
	name, _ := browserRuntimeNames(runtime.scope.SessionID)
	if _, err := manager.inspectOwned(ctx, name, runtime.scope); err != nil {
		return nil
	}
	output, err := manager.docker(ctx, "exec", name, "/usr/local/bin/node", "-e",
		`const fs=require('fs');try{const f=fs.openSync('/tmp/factory-recording-progress.txt','r');const n=fs.fstatSync(f).size;const b=Buffer.alloc(Math.min(n,4096));fs.readSync(f,b,0,b.length,Math.max(0,n-b.length));fs.closeSync(f);const m=[...b.toString().matchAll(/(?:^|\n)out_time_us=(\d+)/g)].at(-1);if(m)process.stdout.write(String(Math.floor(Number(m[1])/1000)))}catch{}`)
	if err != nil {
		return nil
	}
	value, err := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	if err != nil || value < 0 {
		return nil
	}
	return &value
}

// Recording is internal to Factory, never an agent-selected file/tool. Calls
// retain the browser's exact owner, lease, serialization and Stop boundary.
func (manager *browserRuntimeManager) recording(ctx context.Context, scope browserRuntimeRequest, action string) (string, error) {
	manager.mu.Lock()
	runtime := manager.sessions[scope.SessionID]
	manager.mu.Unlock()
	if runtime == nil || !sameBrowserScope(runtime.scope, scope) {
		return "", errors.New("recording browser is unavailable")
	}
	if err := runtime.renewAuthority(scope, true); err != nil {
		return "", err
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closed || runtime.ctx.Err() != nil || runtime.command == nil || runtime.pageID == 0 {
		return "", errors.New("recording browser authority ended")
	}
	bounded, cancel := context.WithTimeout(runtime.ctx, 15*time.Second)
	defer cancel()
	tool := func(name string, args map[string]any) error {
		args["pageId"] = runtime.pageID
		raw, err := runtime.rpc(bounded, "tools/call", map[string]any{"name": name, "arguments": args})
		if err != nil {
			// A lost RPC invalidates protocol synchronization, not just video.
			runtime.cancel()
			go manager.closeSession(scope)
			return err
		}
		var result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(raw, &result) != nil || result.IsError {
			return errors.New("recording encoder outcome unavailable")
		}
		for _, part := range result.Content {
			if strings.Contains(part.Text, "Error:") {
				return errors.New("recording encoder did not confirm capture")
			}
		}
		return nil
	}
	switch action {
	case "browser-recording-start":
		if runtime.recordingStarted.IsZero() {
			if err := tool("screencast_start", map[string]any{"filePath": browserRecordingPath}); err != nil {
				return "", err
			}
			runtime.recordingStarted = time.Now()
		}
		data, _ := json.Marshal(map[string]any{"startedAt": runtime.recordingStarted})
		return string(data), nil
	case "browser-recording-finish":
		if runtime.recordingStarted.IsZero() {
			return "", errors.New("recording was not started")
		}
		if runtime.recordingEnded.IsZero() {
			if err := tool("screencast_stop", map[string]any{}); err != nil {
				return "", err
			}
			runtime.recordingEnded = time.Now()
		}
		name, _ := browserRuntimeNames(scope.SessionID)
		if _, err := manager.inspectOwned(bounded, name, scope); err != nil {
			return "", err
		}
		rawSize, rawErr := manager.docker(bounded, "exec", name, "stat", "-c", "%s", browserRecordingPath)
		rawBytes, rawParsed := strconv.ParseInt(strings.TrimSpace(string(rawSize)), 10, 64)
		if rawErr != nil || rawParsed != nil || rawBytes <= 0 || rawBytes > browserRecordingLimit {
			return "", errors.New("recording file exceeds its bound or is unavailable")
		}
		// Upstream streams WebM through a pipe. Finalize a seekable index by
		// remuxing, without re-encoding or repeating any browser action.
		if !runtime.recordingIndexed {
			if _, err := manager.docker(bounded, "exec", name, "/usr/bin/ffmpeg",
				"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", browserRecordingPath,
				"-map", "0:v:0", "-c:v", "copy", "-an", "/tmp/factory-review-indexed.webm"); err != nil {
				return "", errors.New("recording index publication unavailable")
			}
			if _, err := manager.docker(bounded, "exec", name, "/bin/mv", "-f",
				"/tmp/factory-review-indexed.webm", browserRecordingPath); err != nil {
				return "", errors.New("recording index publication unavailable")
			}
			runtime.recordingIndexed = true
		}
		output, err := manager.docker(bounded, "exec", name, "stat", "-c", "%s", browserRecordingPath)
		size, parsed := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
		if err != nil || parsed != nil || size <= 0 || size > browserRecordingLimit {
			return "", errors.New("recording file exceeds its bound or is unavailable")
		}
		runtime.recordingBytes = size
		duration, probeErr := manager.docker(bounded, "exec", name, "/usr/bin/ffprobe", "-v", "error",
			"-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", browserRecordingPath)
		seconds, parsedDuration := strconv.ParseFloat(strings.TrimSpace(string(duration)), 64)
		if probeErr != nil || parsedDuration != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 ||
			seconds > runtime.recordingEnded.Sub(runtime.recordingStarted).Seconds()*2+2 {
			return "", errors.New("recording duration/index unavailable")
		}
		data, _ := json.Marshal(map[string]any{"bytes": size, "durationMs": int64(seconds * 1000)})
		return string(data), nil
	case "browser-recording-chunk":
		var args struct {
			Offset int64 `json:"offset"`
		}
		if json.Unmarshal(scope.Call.Arguments, &args) != nil || args.Offset < 0 ||
			args.Offset%browserRecordingChunk != 0 || args.Offset >= runtime.recordingBytes ||
			runtime.recordingEnded.IsZero() || runtime.recordingBytes == 0 {
			return "", errors.New("invalid recording chunk")
		}
		name, _ := browserRuntimeNames(scope.SessionID)
		if _, err := manager.inspectOwned(bounded, name, scope); err != nil {
			return "", err
		}
		// Fixed executable, fixed owned path, bounded integer. No shell or
		// generic runtime-file export is exposed.
		output, err := manager.docker(bounded, "exec", name, "/usr/local/bin/node", "-e",
			`const fs=require('fs');const b=Buffer.alloc(49152);const f=fs.openSync('/tmp/factory-review.webm','r');const n=fs.readSync(f,b,0,b.length,Number(process.argv[1]));fs.closeSync(f);process.stdout.write(b.subarray(0,n).toString('base64'))`,
			strconv.FormatInt(args.Offset, 10))
		if err != nil {
			return "", err
		}
		data, _ := json.Marshal(map[string]any{"offset": args.Offset, "data": string(output)})
		return string(data), nil
	}
	return "", errors.New("unsupported recording operation")
}
