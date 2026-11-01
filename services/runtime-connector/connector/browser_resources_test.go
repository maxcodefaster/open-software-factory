package connector

import (
	"strconv"
	"strings"
	"testing"
)

func TestBrowserMemoryBudgetSupportsRecordingWithoutGrowingThePair(t *testing.T) {
	manager, scope := browserRuntimeFixture(t)
	var totalMiB int
	for _, row := range []struct {
		proxy bool
		mib   int
	}{{false, 1408}, {true, 128}} {
		arguments, err := browserCreateArguments(manager.assignment, manager.primaryID, manager.directory(scope.SessionID), scope, row.proxy)
		if err != nil {
			t.Fatal(err)
		}
		var limit string
		for index, argument := range arguments {
			if argument == "--memory" && index+1 < len(arguments) {
				limit = arguments[index+1]
			}
		}
		expected := strconv.Itoa(row.mib) + "m"
		if limit != expected {
			t.Errorf("proxy=%t memory=%q, want %q for the recorded browser/proxy workload", row.proxy, limit, expected)
		}
		value, err := strconv.Atoi(strings.TrimSuffix(limit, "m"))
		if err != nil {
			t.Fatal("memory ceiling is not finite MiB", limit)
		}
		totalMiB += value
	}
	if totalMiB != 1536 {
		t.Fatal("browser/proxy pair increased its aggregate hard ceiling", totalMiB)
	}
}
