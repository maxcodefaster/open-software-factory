package connector

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"syscall"
	"time"
)

type startupMeasurement struct {
	Phase      string `json:"phase"`
	StartedAt  string `json:"startedAt"`
	DurationMS int64  `json:"durationMs"`
}

const startupTimingPath = "/tmp/factory-startup-timings.jsonl"

func resetStartupTimings() {
	if file, err := os.OpenFile(startupTimingPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY|syscall.O_NOFOLLOW, 0600); err == nil {
		file.Close()
	}
}

// Startup timings are ephemeral diagnostics, not product state. Only fixed phase
// names and clocks are emitted; commands, assignments and credentials are excluded.
func startupPhase(phase string) func() {
	var output bytes.Buffer
	finish := measureStartupPhase(phase, &output)
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

func measureStartupPhase(phase string, output io.Writer) func() {
	started := time.Now()
	return func() {
		measurement := startupMeasurement{
			Phase: phase, StartedAt: started.UTC().Format(time.RFC3339Nano),
			DurationMS: time.Since(started).Milliseconds(),
		}
		encoded, _ := json.Marshal(measurement)
		fmt.Fprintln(output, "factory-startup "+string(encoded))
	}
}
