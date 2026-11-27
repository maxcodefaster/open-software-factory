package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	ate "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// The same Project fragment is exercised by Factory's admission parser.
// This proves pinned native wire compatibility, not server/image admission.
func TestProjectTemplateUsesPinnedOfficialContainerAndVolumeWire(t *testing.T) {
	content, err := os.ReadFile("../../test/fixtures/native-project/actor-template.json")
	if err != nil {
		t.Fatal(err)
	}
	var native ate.ActorTemplate
	if err := protojson.Unmarshal(content, &native); err != nil {
		t.Fatal(err)
	}
	if len(native.GetContainers()) != 2 || native.GetContainers()[0].GetName() != "work" ||
		native.GetContainers()[1].GetCommand()[1] != "postgres" ||
		len(native.GetVolumes()) != 2 || native.GetVolumes()[0].GetDurableDir() == nil {
		t.Fatal("Project ActorTemplate lost native container/volume semantics")
	}
	if native.GetMetadata() != nil || native.GetWorkerSelector() != nil || native.GetSnapshotConfig() != nil {
		t.Fatal("Project fragment contains Factory-owned native authority")
	}
	var project map[string]any
	if err := json.Unmarshal(content, &project); err != nil {
		t.Fatal(err)
	}
	work := project["containers"].([]any)[0].(map[string]any)
	for _, field := range []string{"build", "dockerComposeFile", "depends_on", "privileged", "user", "workingDir"} {
		work[field] = "not-a-public-container-field"
		encoded, err := json.Marshal(project)
		if err != nil {
			t.Fatal(err)
		}
		var rejected ate.ActorTemplate
		err = protojson.Unmarshal(encoded, &rejected)
		if err == nil || !strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("public Container unexpectedly accepted %s: %v", field, err)
		}
		delete(work, field)
	}
}
