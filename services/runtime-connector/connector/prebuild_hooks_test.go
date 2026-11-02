package connector

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestPrebuiltProjectHooksUseImageMetadataExactlyOnce(t *testing.T) {
	for _, command := range []string{
		`"required-project-setup"`,
		`["node","-e","required-project-setup"]`,
		`{"first":["node","-e","setup"],"second":"required-project-setup"}`,
	} {
		t.Run(command, func(t *testing.T) {
			config := map[string]json.RawMessage{}
			project := map[string]json.RawMessage{}
			for _, hook := range []string{"onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"} {
				config[hook] = json.RawMessage(command)
				project[hook] = json.RawMessage(command)
			}
			config["initializeCommand"] = json.RawMessage(`"host-setup"`)
			config["remoteUser"] = json.RawMessage(`"node"`)
			metadata, _ := json.Marshal([]any{
				map[string]any{"postCreateCommand": "inherited-image-setup"},
				map[string]any{"id": "./feature", "postCreateCommand": "required-feature-setup"},
				project,
			})
			if err := removePrebuiltProjectHooks(config, string(metadata)); err != nil {
				t.Fatal(err)
			}
			want := map[string]json.RawMessage{
				"initializeCommand": json.RawMessage(`"host-setup"`),
				"remoteUser":        json.RawMessage(`"node"`),
			}
			if !reflect.DeepEqual(config, want) {
				t.Fatalf("consumer repeated prepared hooks or lost other configuration: %s", config)
			}
		})
	}
}

func TestPrebuiltHooksNeverDeduplicateFeaturesOrChangedCommands(t *testing.T) {
	for _, metadata := range []string{
		`[{"id":"./feature","postCreateCommand":"project-setup"}]`,
		`[]`,
		``,
		`[{"postStartCommand":"inherited-start"}]`,
	} {
		config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`"project-setup"`)}
		if err := removePrebuiltProjectHooks(config, metadata); err != nil || config["postCreateCommand"] == nil {
			t.Fatalf("inherited metadata removed the authored Project hook: %s: %v", metadata, err)
		}
	}
	for _, metadata := range []string{
		`[{"postCreateCommand":"other-setup"}]`,
		`not-json`,
		`null`,
	} {
		config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`"project-setup"`)}
		if err := removePrebuiltProjectHooks(config, metadata); err == nil || config["postCreateCommand"] == nil {
			t.Fatalf("changed/invalid metadata did not preserve normal-startup fallback: %s: %v", metadata, err)
		}
	}
}

func TestPrebuiltHookComparisonIgnoresObjectPropertyOrder(t *testing.T) {
	config := map[string]json.RawMessage{"postCreateCommand": json.RawMessage(`{"a":"first","b":"second"}`)}
	if err := removePrebuiltProjectHooks(config, `{"postCreateCommand":{"b":"second","a":"first"}}`); err != nil ||
		config["postCreateCommand"] != nil {
		t.Fatalf("equivalent parallel hook was not recognized: %s: %v", config, err)
	}
}
