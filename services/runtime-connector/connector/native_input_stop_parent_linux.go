package connector

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

type nativeInputStopRecord struct {
	Source sourceRestored         `json:"source"`
	Result *nativeInputStopResult `json:"result,omitempty"`
}

func syncInputStopRecord(path string, value nativeInputStopRecord, first bool) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if first {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		if _, err := file.Write(data); err != nil {
			file.Close()
			return err
		}
		if err := file.Sync(); err != nil {
			file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
	} else {
		file, err := os.CreateTemp(filepath.Dir(path), ".input-stop-result-")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err := file.Write(data); err != nil {
			file.Close()
			return err
		}
		if err := file.Sync(); err != nil {
			file.Close()
			return err
		}
		file.Close()
		if err := os.Rename(file.Name(), path); err != nil {
			return err
		}
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func executeRecordedInputStop(ctx context.Context, b bootstrap, restored sourceRestored) (*nativeInputStopResult, error) {
	input := *restored.InputStop
	path := filepath.Join(b.Assignment.ConnectorStateDir, "input-stop-"+input.StopID+".json")
	record := nativeInputStopRecord{Source: restored}
	data, err := os.ReadFile(path)
	if err == nil {
		var saved nativeInputStopRecord
		if json.Unmarshal(data, &saved) != nil || !reflect.DeepEqual(saved.Source, restored) {
			return nil, errors.New("original native Stop record differs; execution was not repeated")
		}
		if saved.Result != nil {
			expected := input
			expected.Mode = saved.Result.Mode
			if expected.validate() != nil || saved.Result.nativeInputStop != expected || !saved.Result.EngineExited || !saved.Result.ProcessTreeExited {
				return nil, errors.New("recorded native Stop result is invalid")
			}
			return saved.Result, nil
		}
		// A persisted start without a result is unknown. A fresh metadata engine
		// may observe its original database, but must never repeat interruption.
		input.Mode = "observe"
	} else if !os.IsNotExist(err) {
		return nil, err
	} else if err := syncInputStopRecord(path, record, true); err != nil {
		return nil, err
	}
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	result, err := executeNativeInputStop(ctx, input, binary)
	if err != nil && ctx.Err() == nil && input.Mode == "interrupt" {
		// A lost SDK acknowledgement is not authority to repeat cancellation.
		// Join it first, then make one read-only observation of the same DB.
		input.Mode = "observe"
		result, err = executeNativeInputStop(ctx, input, binary)
	}
	if err != nil && ctx.Err() == nil {
		// The fixed executor has returned after joining its private init, or
		// refused before creating it. No Project/engine process can remain.
		// Settlement is still unknown; this only permits preserving Source.
		result = nativeInputStopResult{nativeInputStopWorkerResult: nativeInputStopWorkerResult{nativeInputStop: input, Confirmed: false, EngineExited: true}, ProcessTreeExited: true}
	} else if err != nil {
		return nil, err
	}
	record.Result = &result
	if err := syncInputStopRecord(path, record, false); err != nil {
		// The live Parent can still publish its joined result. On a subsequent
		// process restart, the existing start marker admits observation only.
		return &result, nil
	}
	return &result, nil
}

func inputStopSourceHandler(handler http.Handler, workspaceID string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/v1/workspaces/" + workspaceID + "/"
		if r.Method != http.MethodPost || (r.URL.Path != base+"checkpoint" && r.URL.Path != base+"chunk") || r.URL.RawQuery != "" {
			http.Error(w, "input Stop admits only its retained Source export", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})
}

func serveInputStopParent(ctx context.Context, assignment Assignment, token string, result *nativeInputStopResult, stopID string) error {
	streams := &parentSourceStreams{handler: assignment.nativeSource}
	fence := &parentSourceFence{}
	drain := fence.wrap(func(_ context.Context, message Message) Message {
		reply := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
		switch message.Action {
		case "source-drain":
			// Docker was never started. The metadata namespace was joined before
			// this Source-only Parent was admitted, including failed workers.
		default:
			reply.Error = "input Stop cannot execute Project or runtime operations"
		}
		return reply
	})
	handle := func(ctx context.Context, message Message) Message {
		if message.Action != "input-stop-result" {
			return drain(ctx, message)
		}
		reply := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
		if message.OperationID != stopID || result == nil {
			reply.Error = "native input Stop outcome is unavailable"
		} else {
			data, _ := json.Marshal(result)
			reply.Data = string(data)
		}
		return reply
	}
	operations := startParentOperations(ctx, handle)
	defer operations.stop()
	var backoff reconnectBackoff
	for ctx.Err() == nil {
		control, err := dialControl(ctx, assignment, "parent", token)
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(backoff.next()):
				continue
			}
		}
		if err := control.write(Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation, Channels: parentChannels(assignment)}); err != nil {
			control.close()
			continue
		}
		backoff.reset()
		connectionContext, disconnect := context.WithCancel(ctx)
		closeOnCancel := context.AfterFunc(ctx, func() { control.close() })
		for {
			var message Message
			if control.read(&message) != nil {
				break
			}
			switch message.Type {
			case "http-request":
				streams.start(connectionContext, control, message)
			case "stream-close":
				streams.close(message.StreamID)
			case "operation-request":
				if !operations.submit(control, message) {
					_ = control.write(Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action, Error: "input Stop observation queue is full"})
				}
				// A transport Stop is not native Suspend or authority to discard
				// unsnapshotted files. Continue serving the original Source owner.
			}
		}
		closeOnCancel()
		disconnect()
		control.close()
	}
	return nil
}

func runNativeInputStopParent(ctx context.Context, b bootstrap, restored sourceRestored) error {
	if restored.InputStop == nil {
		return errors.New("native input Stop is not admitted")
	}
	result, _ := executeRecordedInputStop(ctx, b, restored)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	handler, closeSource, err := startNativeSource(ctx, b.Source.WorkspaceID, b.Assignment.Generation,
		restored.WriterEpoch, restored.ChangeWriterEpoch, true, b.Assignment.ConnectorStateDir, cancel)
	if err != nil {
		return err
	}
	defer closeSource()
	b.Assignment.nativeSource = inputStopSourceHandler(handler, b.Source.WorkspaceID)
	b.Assignment.nativeActorUID = restored.ActorUID
	b.Assignment.nativeRetainedSource = true
	return serveInputStopParent(ctx, b.Assignment, b.ParentToken, result, restored.InputStop.StopID)
}
