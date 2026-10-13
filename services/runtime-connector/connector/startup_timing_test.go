package connector

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStartupMeasurementContainsOnlyPhaseAndClocks(t *testing.T) {
	var output bytes.Buffer
	finish := measureStartupPhase("tool-injection", &output)
	finish()
	var measurement map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(output.String()), "factory-startup ")), &measurement); err != nil {
		t.Fatal(err)
	}
	if len(measurement) != 3 || measurement["phase"] != "tool-injection" || measurement["durationMs"].(float64) < 0 {
		t.Fatalf("invalid bounded measurement: %v", measurement)
	}
	if _, err := time.Parse(time.RFC3339Nano, measurement["startedAt"].(string)); err != nil {
		t.Fatal(err)
	}
}
