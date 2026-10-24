package connector

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

type browserRecordingInput struct{ started chan struct{} }

func (input browserRecordingInput) Write(data []byte) (int, error) {
	input.started <- struct{}{}
	return len(data), nil
}
func (browserRecordingInput) Close() error { return nil }

func TestRecordingFinishPollsOneNativeStopAndCancellationEndsIt(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	manager.docker = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	ctx, cancel := context.WithCancel(context.Background())
	input := browserRecordingInput{started: make(chan struct{}, 10)}
	runtime := &browserRuntime{
		scope: scope, directory: manager.directory(scope.SessionID), ctx: ctx, cancel: cancel,
		command: &exec.Cmd{}, input: input,
		responses: make(chan browserMCPReply, 1), pageID: 1,
		recordingStarted: time.Now().Add(-time.Minute),
	}
	manager.sessions[scope.SessionID] = runtime
	t.Cleanup(func() {
		cancel()
		if err := manager.closeAll(); err != nil {
			t.Error(err)
		}
	})
	result := make(chan string, 1)
	go func() {
		value, _ := manager.recording(ctx, scope, "browser-recording-finish")
		result <- value
	}()
	select {
	case value := <-result:
		if value != `{"state":"pending"}` {
			t.Fatal("unfinished encoder did not return pending", value)
		}
	case <-time.After(time.Second):
		cancel()
		<-result
		t.Fatal("recording finalization blocked its status request")
	}
	select {
	case <-input.started:
	case <-time.After(time.Second):
		t.Fatal("native screencast_stop did not start")
	}
	for range 3 {
		if value, err := manager.recording(ctx, scope, "browser-recording-finish"); err != nil || value != `{"state":"pending"}` {
			t.Fatal("polling unfinished encoder", value, err)
		}
	}
	renewal := scope
	renewal.ExpiresAt = time.Now().Add(25 * time.Second)
	if err := manager.renew(renewal); err != nil {
		t.Fatal("renewing encoder finalization", err)
	}
	foreign := renewal
	foreign.OwnerID = "not-the-owner"
	if _, err := manager.recording(ctx, foreign, "browser-recording-finish"); err == nil {
		t.Fatal("another owner observed or started finalization")
	}
	cancel()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.sequence != 1 {
		t.Fatal("native screencast_stop was repeated", runtime.sequence)
	}
}

func TestRecordingDrainRequiresActualEncoderProgress(t *testing.T) {
	for _, advancing := range []bool{false, true} {
		t.Run(strconv.FormatBool(advancing), func(t *testing.T) {
			manager, scope := browserRuntimeFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime := &browserRuntime{
				scope: scope, directory: manager.directory(scope.SessionID), ctx: ctx, cancel: cancel,
				command: &exec.Cmd{}, input: browserRecordingInput{started: make(chan struct{}, 10)},
				responses: make(chan browserMCPReply, 1), pageID: 1,
				recordingStarted: time.Now().Add(-time.Minute),
			}
			probes := 0
			manager.docker = func(_ context.Context, args ...string) ([]byte, error) {
				if args[0] == "inspect" {
					return json.Marshal([]map[string]any{{"Config": map[string]any{
						"Labels": map[string]string{
							"factory.dev/browser-session": scope.SessionID, "factory.dev/browser-turn": scope.TurnID,
							"factory.dev/browser-owner": scope.OwnerID, attemptLabel: manager.assignment.RuntimeAttemptID,
							generationLabel: "3", "com.docker.compose.project": manager.assignment.ComposeProjectName,
						},
					}}})
				}
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
			data, err := manager.stopRecording(runtime, 120*time.Millisecond)
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
