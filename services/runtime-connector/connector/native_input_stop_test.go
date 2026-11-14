package connector

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func ownedInputStop() nativeInputStop {
	return nativeInputStop{
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
	if err := input.validate(); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(input)
	var read nativeInputStop
	if err := readInputStopJSON(bytes.NewReader(encoded), &read); err != nil || read != input {
		t.Fatal("exact metadata assignment changed", err)
	}
	for _, mutation := range []func(*nativeInputStop){
		func(i *nativeInputStop) { i.StopID = "unbound" },
		func(i *nativeInputStop) { i.AttemptID = i.AttemptID[:35] },
		func(i *nativeInputStop) { i.SessionID = "../source" },
		func(i *nativeInputStop) { i.SessionID = "ses_" + strings.Repeat("x", 256) },
		func(i *nativeInputStop) { i.PromptID = "unbound" },
		func(i *nativeInputStop) { i.ModelID = "" },
		func(i *nativeInputStop) { i.ModelID = strings.Repeat("x", 201) },
		func(i *nativeInputStop) { i.ModelID = "model\nconfiguration" },
		func(i *nativeInputStop) { i.Version = "current" },
		func(i *nativeInputStop) { i.Mode = "execute" },
	} {
		changed := input
		mutation(&changed)
		if changed.validate() == nil {
			t.Fatalf("changed metadata was accepted: %+v", changed)
		}
	}
	for _, invalid := range []string{
		string(encoded) + "{}",
		string(encoded[:len(encoded)-1]) + `,"command":["must-not-run"]}`,
		strings.Repeat(" ", inputStopBytes) + string(encoded),
	} {
		if readInputStopJSON(strings.NewReader(invalid), &read) == nil {
			t.Fatal("unknown, trailing or oversized metadata was accepted")
		}
	}
}

func TestNativeInputStopCannotAcceptWorkerAssertedProcessTreeExitOrDifferentAssignment(t *testing.T) {
	input := ownedInputStop()
	result := nativeInputStopWorkerResult{nativeInputStop: input, Confirmed: true, EngineExited: true}
	encoded, _ := json.Marshal(result)
	confirmed, err := confirmInputStopWorkerResult(input, encoded)
	if err != nil || !confirmed.ProcessTreeExited || confirmed.nativeInputStop != input {
		t.Fatal("exact joined worker result changed", err)
	}
	for _, mutation := range []func(*nativeInputStopWorkerResult){
		func(r *nativeInputStopWorkerResult) { r.StopID = r.AttemptID },
		func(r *nativeInputStopWorkerResult) { r.AttemptID = r.StopID },
		func(r *nativeInputStopWorkerResult) { r.SessionID += "_different" },
		func(r *nativeInputStopWorkerResult) { r.PromptID += "_different" },
		func(r *nativeInputStopWorkerResult) { r.ModelID += "-different" },
		func(r *nativeInputStopWorkerResult) { r.Version = "2.0.28" },
		func(r *nativeInputStopWorkerResult) { r.Confirmed = false },
		func(r *nativeInputStopWorkerResult) { r.EngineExited = false },
	} {
		changed := result
		mutation(&changed)
		data, _ := json.Marshal(changed)
		if _, err := confirmInputStopWorkerResult(input, data); err == nil {
			t.Fatal("foreign or unfinished worker was accepted")
		}
	}
	for _, data := range []string{
		string(encoded[:len(encoded)-1]) + `,"processTreeExited":true}`,
		string(encoded) + "{}",
		strings.Repeat("x", inputStopBytes+1),
	} {
		if _, err := confirmInputStopWorkerResult(input, []byte(data)); err == nil {
			t.Fatal("worker asserted a trusted process boundary")
		}
	}
}
