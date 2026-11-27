package inputstop

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func ownedInputStop() Assignment {
	return Assignment{
		StopID:    "3e19c23e-b909-4564-8eb9-6804617f3b3e",
		AttemptID: "695b38cf-a84c-51f7-8107-15c7f5a78503",
		SessionID: "ses_owned_native_stop",
		PromptID:  "msg_owned_native_input",
		ModelID:   "owned-factory-model",
		Version:   "2.0.27",
		Mode:      "interrupt",
	}
}

func TestNativeInputStopRequiresExactBoundedMetadataOnlyAssignment(t *testing.T) {
	input := ownedInputStop()
	if err := input.Validate(); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(input)
	var read Assignment
	if err := ReadJSON(bytes.NewReader(encoded), &read); err != nil || read != input {
		t.Fatal("exact metadata assignment changed", err)
	}
	for _, mutation := range []func(*Assignment){
		func(i *Assignment) { i.StopID = "unbound" },
		func(i *Assignment) { i.AttemptID = i.AttemptID[:35] },
		func(i *Assignment) { i.SessionID = "../source" },
		func(i *Assignment) { i.SessionID = "ses_" + strings.Repeat("x", 256) },
		func(i *Assignment) { i.PromptID = "unbound" },
		func(i *Assignment) { i.ModelID = "" },
		func(i *Assignment) { i.ModelID = strings.Repeat("x", 201) },
		func(i *Assignment) { i.ModelID = "model\nconfiguration" },
		func(i *Assignment) { i.Version = "current" },
		func(i *Assignment) { i.Mode = "execute" },
	} {
		changed := input
		mutation(&changed)
		if changed.Validate() == nil {
			t.Fatalf("changed metadata was accepted: %+v", changed)
		}
	}
	for _, invalid := range []string{
		string(encoded) + "{}",
		string(encoded[:len(encoded)-1]) + `,"command":["must-not-run"]}`,
		strings.Repeat(" ", inputStopBytes) + string(encoded),
	} {
		if ReadJSON(strings.NewReader(invalid), &read) == nil {
			t.Fatal("unknown, trailing or oversized metadata was accepted")
		}
	}
}

func TestNativeInputStopCannotAcceptWorkerAssertedProcessTreeExitOrDifferentAssignment(t *testing.T) {
	input := ownedInputStop()
	result := WorkerResult{Assignment: input, Confirmed: true, EngineExited: true}
	encoded, _ := json.Marshal(result)
	confirmed, err := ConfirmWorkerResult(input, encoded)
	if err != nil || !confirmed.ProcessTreeExited || confirmed.Assignment != input {
		t.Fatal("exact joined worker result changed", err)
	}
	for _, mutation := range []func(*WorkerResult){
		func(r *WorkerResult) { r.StopID = r.AttemptID },
		func(r *WorkerResult) { r.AttemptID = r.StopID },
		func(r *WorkerResult) { r.SessionID += "_different" },
		func(r *WorkerResult) { r.PromptID += "_different" },
		func(r *WorkerResult) { r.ModelID += "-different" },
		func(r *WorkerResult) { r.Version = "2.0.28" },
		func(r *WorkerResult) { r.Confirmed = false },
		func(r *WorkerResult) { r.EngineExited = false },
	} {
		changed := result
		mutation(&changed)
		data, _ := json.Marshal(changed)
		if _, err := ConfirmWorkerResult(input, data); err == nil {
			t.Fatal("foreign or unfinished worker was accepted")
		}
	}
	for _, data := range []string{
		string(encoded[:len(encoded)-1]) + `,"processTreeExited":true}`,
		string(encoded) + "{}",
		strings.Repeat("x", inputStopBytes+1),
	} {
		if _, err := ConfirmWorkerResult(input, []byte(data)); err == nil {
			t.Fatal("worker asserted a trusted process boundary")
		}
	}
}
