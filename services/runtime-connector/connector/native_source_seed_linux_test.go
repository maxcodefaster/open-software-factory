package connector

import (
	"encoding/json"
	"strings"
	"testing"
)

func sourceSeedRestoreJSON() map[string]any {
	return map[string]any{
		"actorUID": "526dbdeb-6396-42c2-a0ab-6a69f5173b36", "checkpointActorUID": nil,
		"checkpointSeedID": "1ee029eb-4277-42d7-ad99-731398659749",
		"writerEpoch":      2, "changeWriterEpoch": 1,
		"checkpoint": map[string]any{
			"id": "375460ae-0b12-4efb-98b0-5ce0ca928a8d", "workspaceID": "11345112-f121-4739-b2f3-6c6cf60bd2bf",
			"actorUID": nil, "seedID": "1ee029eb-4277-42d7-ad99-731398659749", "writerEpoch": 1, "generation": 1,
			"bundle": map[string]any{"version": 1, "bytes": 8, "sha256": strings.Repeat("a", 64), "chunks": []string{strings.Repeat("a", 64)}},
		},
	}
}

func decodeSourceRestoreTest(t *testing.T, wire map[string]any) sourceRestoreResponse {
	t.Helper()
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var reply sourceRestoreResponse
	if err := json.Unmarshal(data, &reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestSubstrateSourceRestoreAcceptsTruthfulPreActorSeed(t *testing.T) {
	reply := decodeSourceRestoreTest(t, sourceSeedRestoreJSON())
	if err := validateSourceRestoreLease(reply, reply.Checkpoint.WorkspaceID, reply.ActorUID, 1); err != nil {
		t.Fatal("first Actor rejected its Source-service seed:", err)
	}
	changed := sourceSeedRestoreJSON()
	changed["checkpointSeedID"] = "9e6d84df-2a59-41e8-b5bc-1711af5bcc3e"
	if sameSourceRestoreLease(decodeSourceRestoreTest(t, changed), reply) {
		t.Fatal("publication check ignored a changed seed provenance")
	}
	for _, generation := range []uint64{0, 2, 3, 100} {
		if err := validateSourceRestoreLease(reply, reply.Checkpoint.WorkspaceID, reply.ActorUID, generation); err == nil {
			t.Fatalf("seed restore accepted actual assignment generation %d", generation)
		}
	}
}

func TestSubstrateSourceRestoreRejectsAmbiguousMissingAndDifferentSeedProvenance(t *testing.T) {
	const actorUID = "526dbdeb-6396-42c2-a0ab-6a69f5173b36"
	for name, mutate := range map[string]func(map[string]any, map[string]any){
		"missing-seed":          func(w, c map[string]any) { delete(c, "seedID") },
		"null-seed":             func(w, c map[string]any) { c["seedID"] = nil },
		"empty-seed":            func(w, c map[string]any) { c["seedID"] = "" },
		"invalid-seed":          func(w, c map[string]any) { c["seedID"] = strings.Repeat("x", 36) },
		"missing-lease-seed":    func(w, c map[string]any) { delete(w, "checkpointSeedID") },
		"null-lease-seed":       func(w, c map[string]any) { w["checkpointSeedID"] = nil },
		"empty-lease-seed":      func(w, c map[string]any) { w["checkpointSeedID"] = "" },
		"different-lease-seed":  func(w, c map[string]any) { w["checkpointSeedID"] = actorUID },
		"checkpoint-has-actor":  func(w, c map[string]any) { c["actorUID"] = actorUID },
		"lease-has-actor":       func(w, c map[string]any) { w["checkpointActorUID"] = actorUID },
		"both-have-actor":       func(w, c map[string]any) { c["actorUID"], w["checkpointActorUID"] = actorUID, actorUID },
		"no-native-actor":       func(w, c map[string]any) { w["actorUID"] = nil },
		"malformed-native":      func(w, c map[string]any) { w["actorUID"] = strings.Repeat("x", 36) },
		"malformed-checkpoint":  func(w, c map[string]any) { c["id"] = strings.Repeat("x", 36) },
		"wrong-workspace":       func(w, c map[string]any) { c["workspaceID"] = actorUID },
		"stale-writer":          func(w, c map[string]any) { c["writerEpoch"] = w["writerEpoch"] },
		"missing-writer":        func(w, c map[string]any) { w["writerEpoch"] = 0 },
		"missing-change-writer": func(w, c map[string]any) { w["changeWriterEpoch"] = 0 },
		"missing-generation":    func(w, c map[string]any) { c["generation"] = 0 },
		"input-stop": func(w, c map[string]any) {
			input := ownedInputStop()
			w["readOnly"], w["inputStop"] = true, input
		},
		"invalid-matching-seeds": func(w, c map[string]any) {
			w["checkpointSeedID"], c["seedID"] = strings.Repeat("a", 36), strings.Repeat("a", 36)
		},
		"no-provenance": func(w, c map[string]any) { delete(c, "seedID"); w["checkpointSeedID"] = nil },
	} {
		t.Run(name, func(t *testing.T) {
			wire := sourceSeedRestoreJSON()
			mutate(wire, wire["checkpoint"].(map[string]any))
			reply := decodeSourceRestoreTest(t, wire)
			if err := validateSourceRestoreLease(reply, "11345112-f121-4739-b2f3-6c6cf60bd2bf", actorUID, 1); err == nil {
				t.Fatal("unbound Source seed was accepted")
			}
		})
	}
}

func TestSubstrateSourceRestoreActorCheckpointExcludesAllSeedProvenance(t *testing.T) {
	const predecessorUID = "9e6d84df-2a59-41e8-b5bc-1711af5bcc3e"
	for _, variant := range []string{"actor-only", "checkpoint-seed", "lease-seed", "both-seeds", "empty-checkpoint-seed", "empty-lease-seed"} {
		t.Run(variant, func(t *testing.T) {
			wire := sourceSeedRestoreJSON()
			checkpoint := wire["checkpoint"].(map[string]any)
			checkpoint["actorUID"], wire["checkpointActorUID"] = predecessorUID, predecessorUID
			switch variant {
			case "actor-only":
				delete(checkpoint, "seedID")
				wire["checkpointSeedID"] = nil
			case "checkpoint-seed":
				wire["checkpointSeedID"] = nil
			case "lease-seed":
				delete(checkpoint, "seedID")
			case "empty-checkpoint-seed":
				checkpoint["seedID"], wire["checkpointSeedID"] = "", nil
			case "empty-lease-seed":
				delete(checkpoint, "seedID")
				wire["checkpointSeedID"] = ""
			}
			reply := decodeSourceRestoreTest(t, wire)
			err := validateSourceRestoreLease(reply, reply.Checkpoint.WorkspaceID, reply.ActorUID, 3)
			if (err == nil) != (variant == "actor-only") {
				t.Fatal("Actor checkpoint did not enforce exclusive Actor provenance:", err)
			}
		})
	}
}

func TestSubstrateSourceRestoreRejectsStraySeedAndMalformedActorProvenance(t *testing.T) {
	for _, field := range []string{"checkpointActorUID", "checkpointSeedID"} {
		t.Run("no-checkpoint-"+field, func(t *testing.T) {
			wire := sourceSeedRestoreJSON()
			wire["checkpoint"] = nil
			wire[field] = "1ee029eb-4277-42d7-ad99-731398659749"
			reply := decodeSourceRestoreTest(t, wire)
			if err := validateSourceRestoreLease(reply, "", reply.ActorUID, 1); err == nil {
				t.Fatal("checkpoint-free restore accepted stray provenance")
			}
		})
	}
	wire := sourceSeedRestoreJSON()
	checkpoint := wire["checkpoint"].(map[string]any)
	delete(checkpoint, "seedID")
	wire["checkpointSeedID"] = nil
	checkpoint["actorUID"] = strings.Repeat("x", 36)
	wire["checkpointActorUID"] = checkpoint["actorUID"]
	reply := decodeSourceRestoreTest(t, wire)
	if err := validateSourceRestoreLease(reply, reply.Checkpoint.WorkspaceID, reply.ActorUID, 1); err == nil {
		t.Fatal("malformed Actor checkpoint provenance was accepted")
	}
}
