package procutil

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"syscall"
	"time"
)

type StartupMeasurement struct {
	Phase      string `json:"phase"`
	StartedAt  string `json:"startedAt"`
	DurationMS int64  `json:"durationMs"`
}

const startupTimingPath = "/tmp/factory-startup-timings.jsonl"

func ResetStartupTimings() {
	if file, err := os.OpenFile(startupTimingPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY|syscall.O_NOFOLLOW, 0600); err == nil {
		file.Close()
	}
}

// StartupPhase records ephemeral startup diagnostics, not product state. Only
// fixed phase names and clocks are emitted; commands, assignments and
// credentials are excluded.
func StartupPhase(phase string) func() {
	var output bytes.Buffer
	finish := MeasureStartupPhase(phase, &output)
	return func() {
		finish()
		os.Stderr.Write(output.Bytes())
		// Attached output may buffer late records. Keep the same bounded
		// clocks in ephemeral container /tmp, never in the durable Workspace.
		if file, err := os.OpenFile(startupTimingPath, os.O_APPEND|os.O_WRONLY|syscall.O_NOFOLLOW, 0600); err == nil {
			file.Write(output.Bytes())
			file.Close()
		}
	}
}

func MeasureStartupPhase(phase string, output io.Writer) func() {
	started := time.Now()
	return func() {
		measurement := StartupMeasurement{
			Phase: phase, StartedAt: started.UTC().Format(time.RFC3339Nano),
			DurationMS: time.Since(started).Milliseconds(),
		}
		encoded, _ := json.Marshal(measurement)
		fmt.Fprintln(output, "factory-startup "+string(encoded))
	}
}
