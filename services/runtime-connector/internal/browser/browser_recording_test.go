package browser

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

func TestRecordingPresentationPositionDoesNotUseDelayedEncoderOutput(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	runtime := worker.runtime
	runtime.pageID, runtime.app = 1, "web"
	runtime.recordingStarted = time.Now().Add(-7 * time.Minute)
	scope.Call = browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}
	reads := 0
	worker.command = func(_ context.Context, executable string, args ...string) ([]byte, error) {
		if executable != "/usr/local/bin/node" || len(args) != 2 || args[0] != "-e" {
			t.Fatal("position probe changed its fixed native file command", executable, args)
		}
		reads++
		if strings.Contains(args[len(args)-1], "factory-recording-position.txt") {
			return []byte("1600"), nil
		}
		return []byte("200"), nil
	}
	worker.observe = func(context.Context, browserRuntimeRequest, string) (*browserInspectionContext, error) {
		return &browserInspectionContext{
			SessionID: scope.SessionID, TurnID: scope.TurnID, AttemptID: worker.assignment.RuntimeAttemptID,
			Generation: worker.assignment.Generation, App: "web", HeadCommit: strings.Repeat("c", 40),
		}, nil
	}
	observe := func(sequence int) *int64 {
		t.Helper()
		runtime.responses <- browserMCPReply{ID: sequence, Result: json.RawMessage(`{"content":[{"type":"text","text":"Current App snapshot"}]}`)}
		raw, err := worker.call(scope)
		var result browserMCPContent
		if err != nil || json.Unmarshal([]byte(raw), &result) != nil || result.StructuredContent == nil {
			t.Fatal("native recording observation unavailable", raw, err)
		}
		return result.StructuredContent.RecordingTimeMS
	}
	if position := observe(1); position == nil || *position != 1600 {
		t.Fatal("chapter position followed stale encoded progress or wall time", position)
	}
	progress := readBrowserRecordingPosition(context.Background(), worker.command, true)
	if progress == nil || *progress != 200 || reads != 2 {
		t.Fatal("encoder liveness stopped observing actual output", progress)
	}
	runtime.recordingEnded = time.Now()
	if observe(2) != nil || reads != 2 {
		t.Fatal("an ended recording emitted a new observation position")
	}
}

type browserRecordingInput struct{ started chan struct{} }

func (input browserRecordingInput) Write(data []byte) (int, error) {
	input.started <- struct{}{}
	return len(data), nil
}
func (browserRecordingInput) Close() error { return nil }

func TestRecordingFinishPollsOneNativeStopAndCancellationEndsIt(t *testing.T) {
	worker, scope := browserRuntimeFixture(t)
	runtime := worker.runtime
	worker.command = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	input := browserRecordingInput{started: make(chan struct{}, 10)}
	runtime.input, runtime.pageID, runtime.recordingStarted = input, 1, time.Now().Add(-time.Minute)
	poll := func() protocol.Message {
		t.Helper()
		result := make(chan protocol.Message, 1)
		go func() {
			result <- worker.handle(context.Background(), browserScopeMessage(worker, scope, "browser-recording-finish"))
		}()
		select {
		case value := <-result:
			return value
		case <-time.After(time.Second):
			// Join the controlled request on failure too. A native admission
			// lock must not turn a short status read into an encoder wait.
			runtime.cancel()
			select {
			case <-result:
			case <-time.After(time.Second):
				t.Fatal("cancelled recording status request did not join")
			}
			t.Fatal("recording finalization blocked its status request")
		}
		return protocol.Message{}
	}
	if value := poll(); value.Error != "" || value.Data != `{"state":"pending"}` {
		t.Fatal("unfinished encoder did not return pending", value)
	}
	select {
	case <-input.started:
	case <-time.After(time.Second):
		t.Fatal("native screencast_stop did not start")
	}
	for range 3 {
		if value := poll(); value.Error != "" || value.Data != `{"state":"pending"}` {
			t.Fatal("polling unfinished encoder", value)
		}
	}
	renewal := scope
	renewal.ExpiresAt = time.Now().Add(25 * time.Second)
	if response := worker.handle(context.Background(), browserScopeMessage(worker, renewal, "browser-renew")); response.Error != "" {
		t.Fatal("renewing encoder finalization", response.Error)
	}
	foreign := renewal
	foreign.OwnerID = strings.Repeat("d", 64)
	if response := worker.handle(context.Background(), browserScopeMessage(worker, foreign, "browser-recording-finish")); response.Error == "" {
		t.Fatal("another owner observed or started finalization")
	}
	runtime.cancel()
	runtime.recordingMu.Lock()
	finish := runtime.recordingFinish
	runtime.recordingMu.Unlock()
	select {
	case <-finish.done:
	case <-time.After(time.Second):
		t.Fatal("cancelled recording finalization did not join")
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.sequence != 1 {
		t.Fatal("native screencast_stop was repeated", runtime.sequence)
	}
}

func TestRecordingDrainRequiresActualEncoderProgress(t *testing.T) {
	for _, advancing := range []bool{false, true} {
		t.Run(strconv.FormatBool(advancing), func(t *testing.T) {
			worker, _ := browserRuntimeFixture(t)
			runtime := worker.runtime
			runtime.input, runtime.pageID = browserRecordingInput{started: make(chan struct{}, 10)}, 1
			runtime.recordingStarted = time.Now().Add(-time.Minute)
			probes := 0
			worker.command = func(context.Context, string, ...string) ([]byte, error) {
				probes++
				if advancing {
					if probes == 6 {
						runtime.responses <- browserMCPReply{ID: 1, Result: json.RawMessage(`{"content":[]}`)}
					}
					return []byte(strconv.Itoa(probes)), nil
				}
				return []byte("0"), nil
			}
			started := time.Now()
			data, err := stopBrowserRecording(runtime, 120*time.Millisecond, worker.command)
			if advancing {
				if err != nil || string(data) != `{"content":[]}` || time.Since(started) <= 120*time.Millisecond {
					t.Fatal("advancing encoder was cut off by a total-duration deadline", string(data), err)
				}
			} else if err == nil || err.Error() != "recording encoder stopped making progress" {
				t.Fatal("stalled encoder did not end at its no-progress bound", err)
			}
			if runtime.sequence != 1 {
				t.Fatal("draining repeated the upstream stop command", runtime.sequence)
			}
		})
	}
}
