package connector

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func retainedSourceFixture(t *testing.T) (bootstrap, string, map[string]any, map[string]any) {
	t.Helper()
	const actorUID = "526dbdeb-6396-42c2-a0ab-6a69f5173b36"
	var b bootstrap
	b.ParentToken = "owned-parent"
	b.Source.ProjectID, b.Source.WorkspaceID = "owned-project", "11345112-f121-4739-b2f3-6c6cf60bd2bf"
	b.Assignment.RuntimeAttemptID, b.Assignment.Generation = "owned-attempt", 2
	root := t.TempDir()
	b.Assignment.WorkspaceFolder, b.Assignment.ConnectorStateDir = filepath.Join(root, "project"), filepath.Join(root, "control")
	for _, directory := range []string{b.Assignment.WorkspaceFolder, b.Assignment.ConnectorStateDir} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	project := b.Assignment.WorkspaceFolder
	git := func(args ...string) {
		t.Helper()
		if output, err := exec.CommandContext(t.Context(), "git", append([]string{"-C", project}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("owned retained checkout: %v %s", err, output)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(project, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init")
	git("config", "factory.repositoryIdentity", b.Source.ProjectID)
	write("tracked", "initial source\n")
	git("add", "tracked")
	git("-c", "user.name=Owned Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "initial")
	write("tracked", "staged edits\n")
	git("add", "tracked")
	write("tracked", "unsaved-to-index edits\n")
	write("untracked", "retained untracked data\n")
	if err := os.Link(filepath.Join(project, "untracked"), filepath.Join(project, "hardlink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("tracked", filepath.Join(project, "symlink")); err != nil {
		t.Fatal(err)
	}
	// A user's edited template must not replay preparation or first-import checks.
	b.Assignment.ActorTemplatePath = ".factory/actor-template.json"
	b.ProjectTemplate = &nativeProjectTemplate{Path: b.Assignment.ActorTemplatePath, SHA256: strings.Repeat("f", 64)}
	proof := map[string]any{
		"version": 1, "workspaceID": b.Source.WorkspaceID, "projectID": b.Source.ProjectID,
		"attemptID": b.Assignment.RuntimeAttemptID, "generation": b.Assignment.Generation,
		"actorUID": actorUID, "writerEpoch": 2,
		"checkpointID": "375460ae-0b12-4efb-98b0-5ce0ca928a8d",
	}
	wire := map[string]any{
		"version": 2, "retained": true, "actorUID": actorUID, "writerEpoch": 2,
		"changeWriterEpoch": 43, "readOnly": false, "checkpoint": nil,
	}
	return b, actorUID, proof, wire
}

func writeRetainedSourceProof(t *testing.T, b bootstrap, proof map[string]any) {
	t.Helper()
	data, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.Assignment.ConnectorStateDir, "source-imported.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

// Observe real files and Git metadata at the restore seam, not a controller's
// assertion that no import occurred. Even replacing an identical file must fail.
func retainedSourceUnchanged(t *testing.T, project string) func() {
	t.Helper()
	type entry struct {
		info os.FileInfo
		data []byte
	}
	capture := func() map[string]entry {
		t.Helper()
		result := map[string]entry{}
		if err := filepath.Walk(project, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			var data []byte
			if info.Mode().IsRegular() {
				data, err = os.ReadFile(path)
			} else if info.Mode()&os.ModeSymlink != 0 {
				var target string
				target, err = os.Readlink(path)
				data = []byte(target)
			}
			result[path] = entry{info, data}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := capture()
	return func() {
		t.Helper()
		after := capture()
		if len(after) != len(before) {
			t.Fatal("retained checkout entries changed")
		}
		for path, previous := range before {
			current, ok := after[path]
			if !ok || !os.SameFile(previous.info, current.info) || previous.info.Mode() != current.info.Mode() ||
				!previous.info.ModTime().Equal(current.info.ModTime()) || !bytes.Equal(previous.data, current.data) {
				t.Fatalf("retained checkout/Git bytes, metadata or inode changed: %s", path)
			}
		}
	}
}

func retainedSourceRestore(t *testing.T, b bootstrap, actorUID string, wire map[string]any) error {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.URL.RawQuery != "" ||
			r.URL.Path != "/internal/substrate-source/"+b.Assignment.RuntimeAttemptID ||
			r.Header.Get("Authorization") != "Bearer owned-parent" ||
			r.Header.Get("X-Factory-Runtime-Actor-UID") != actorUID ||
			r.Header.Get("X-Factory-Runtime-Generation") != "2" ||
			r.Header.Get("X-Factory-Source-Protocol") != "2" {
			t.Error("retained Source requested a download/commit or lost its exact authority")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		json.NewEncoder(w).Encode(wire)
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL + "/internal/substrate-source/" + b.Assignment.RuntimeAttemptID)
	err := restoreSubstrateSource(t.Context(), b, actorUID, server.Client(), endpoint)
	if calls.Load() > 1 {
		t.Fatalf("retained Source performed %d requests instead of one authenticated lease read", calls.Load())
	}
	if stages, err := filepath.Glob(filepath.Join(filepath.Dir(b.Assignment.WorkspaceFolder), ".factory-source-restore-*")); err != nil || len(stages) != 0 {
		t.Fatal("retained Source staged/materialized an import")
	}
	return err
}

func TestSubstrateSourceRetainedColdRestorePreservesCheckoutAndRefreshesRole(t *testing.T) {
	for _, readOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "writable", true: "read-only"}[readOnly], func(t *testing.T) {
			b, actorUID, proof, wire := retainedSourceFixture(t)
			writeRetainedSourceProof(t, b, proof)
			proofPath := filepath.Join(b.Assignment.ConnectorStateDir, "source-imported.json")
			proofInfo, err := os.Stat(proofPath)
			if err != nil {
				t.Fatal(err)
			}
			unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
			defer unchanged()
			// There need not be a role marker: the first commit ACK may have
			// succeeded just before the original process died.
			for i, role := range []uint64{43, 44} {
				currentReadOnly := readOnly != (i == 1)
				wire["changeWriterEpoch"], wire["readOnly"] = role, currentReadOnly
				if err := retainedSourceRestore(t, b, actorUID, wire); err != nil {
					t.Fatal("same Actor cold continuation rejected its private published import:", err)
				}
				marker, err := readNativeRestored(b, actorUID)
				if err != nil || marker.WriterEpoch != 2 || marker.ChangeWriterEpoch != role || marker.ReadOnly != currentReadOnly || marker.InputStop != nil {
					t.Fatalf("current authenticated lease did not refresh cold Work role: %+v %v", marker, err)
				}
			}
			current, err := os.Stat(proofPath)
			if err != nil || !os.SameFile(proofInfo, current) {
				t.Fatal("retained Source rewrote its original private import identity")
			}
		})
	}
}

func TestSubstrateSourceRetainedColdRestoreUsesDurableFirstPublication(t *testing.T) {
	b, actorUID, _, wire := retainedSourceFixture(t)
	unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
	defer unchanged()
	reply := decodeSourceRestoreTest(t, sourceSeedRestoreJSON())
	if err := persistSourceImport(b, reply); err != nil {
		t.Fatal("first publication could not persist its private identity:", err)
	}
	path := filepath.Join(b.Assignment.ConnectorStateDir, "source-imported.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode() != 0600 {
		t.Fatal("first publication did not leave private proof:", err)
	}
	// No final role marker/ACK record is needed when the authenticated Factory
	// lease confirms that this exact published import became its Actor owner.
	if err := retainedSourceRestore(t, b, actorUID, wire); err != nil {
		t.Fatal("durable first publication was not retained:", err)
	}
	reply.ActorUID = reply.Checkpoint.ID
	if err := persistSourceImport(b, reply); err == nil {
		t.Fatal("another publication replaced the original import identity")
	}
	if after, err := os.ReadFile(path); err != nil || !bytes.Equal(before, after) {
		t.Fatal("original private import identity was changed")
	}
}

func TestSubstrateSourceRetainedColdRestoreRefusesInitialSeedReplay(t *testing.T) {
	b, actorUID, proof, _ := retainedSourceFixture(t)
	writeRetainedSourceProof(t, b, proof)
	unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
	defer unchanged()
	wire := sourceSeedRestoreJSON()
	if err := retainedSourceRestore(t, b, actorUID, wire); err == nil {
		t.Fatal("a published Actor reimported its old initial seed")
	}
}

func TestSubstrateSourceRetainedColdRestoreRejectsForeignOrUnconfirmedCheckout(t *testing.T) {
	for name, mutate := range map[string]func(*testing.T, *bootstrap, map[string]any){
		"missing-proof": func(t *testing.T, b *bootstrap, p map[string]any) {
			if err := os.Remove(filepath.Join(b.Assignment.ConnectorStateDir, "source-imported.json")); err != nil {
				t.Fatal(err)
			}
		},
		"foreign-workspace":  func(_ *testing.T, _ *bootstrap, p map[string]any) { p["workspaceID"] = p["actorUID"] },
		"foreign-project":    func(_ *testing.T, _ *bootstrap, p map[string]any) { p["projectID"] = "foreign-project" },
		"foreign-actor":      func(_ *testing.T, _ *bootstrap, p map[string]any) { p["actorUID"] = p["workspaceID"] },
		"foreign-attempt":    func(_ *testing.T, _ *bootstrap, p map[string]any) { p["attemptID"] = "foreign-attempt" },
		"foreign-generation": func(_ *testing.T, _ *bootstrap, p map[string]any) { p["generation"] = 3 },
		"foreign-owner":      func(_ *testing.T, _ *bootstrap, p map[string]any) { p["writerEpoch"] = 3 },
		"missing-checkpoint": func(_ *testing.T, _ *bootstrap, p map[string]any) { delete(p, "checkpointID") },
		"unknown-version":    func(_ *testing.T, _ *bootstrap, p map[string]any) { p["version"] = 2 },
		"public-state": func(t *testing.T, b *bootstrap, _ map[string]any) {
			if err := os.Chmod(b.Assignment.ConnectorStateDir, 0755); err != nil {
				t.Fatal(err)
			}
		},
		"missing-checkout": func(t *testing.T, b *bootstrap, _ map[string]any) {
			original := b.Assignment.WorkspaceFolder
			b.Assignment.WorkspaceFolder += "-missing"
			t.Cleanup(func() {
				if _, err := os.Stat(original); err != nil {
					t.Error("original checkout removed:", err)
				}
			})
		},
	} {
		t.Run(name, func(t *testing.T) {
			b, actorUID, proof, wire := retainedSourceFixture(t)
			unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
			defer unchanged()
			writeRetainedSourceProof(t, b, proof)
			mutate(t, &b, proof)
			if name != "missing-proof" {
				writeRetainedSourceProof(t, b, proof)
			}
			// A stale execution marker alone is never private import proof.
			role, _ := json.Marshal(sourceRestored{AttemptID: b.Assignment.RuntimeAttemptID, Generation: b.Assignment.Generation,
				ActorUID: actorUID, WriterEpoch: 2, ChangeWriterEpoch: 1})
			if err := os.WriteFile(filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json"), role, 0600); err != nil {
				t.Fatal(err)
			}
			if err := retainedSourceRestore(t, b, actorUID, wire); err == nil {
				t.Fatal("foreign/unconfirmed checkout was adopted")
			}
			if _, err := readNativeRestored(b, actorUID); err == nil {
				t.Fatal("failed retained admission left a usable cold Work marker")
			}
		})
	}
}

func TestSubstrateSourceRetainedColdRestoreRejectsUnsafeProof(t *testing.T) {
	for _, variant := range []string{"malformed", "oversized", "trailing", "public", "symlink", "hardlink", "directory", "foreign-owner"} {
		t.Run(variant, func(t *testing.T) {
			b, actorUID, proof, wire := retainedSourceFixture(t)
			writeRetainedSourceProof(t, b, proof)
			unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
			defer unchanged()
			path := filepath.Join(b.Assignment.ConnectorStateDir, "source-imported.json")
			var err error
			switch variant {
			case "malformed":
				err = os.WriteFile(path, []byte("{"), 0600)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat(" ", 4096)+"{}"), 0600)
			case "trailing":
				file, openErr := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
				if openErr != nil {
					t.Fatal(openErr)
				}
				_, err = file.WriteString("{}")
				file.Close()
			case "public":
				err = os.Chmod(path, 0644)
			case "symlink", "hardlink":
				target := filepath.Join(t.TempDir(), "foreign-proof")
				if err = os.Rename(path, target); err == nil {
					if variant == "symlink" {
						err = os.Symlink(target, path)
					} else if err = os.Link(target, path); err == nil {
						// Keep both links: a private-looking hardlink is not private.
						t.Cleanup(func() { os.Remove(target) })
					}
				}
			case "directory":
				if err = os.Remove(path); err == nil {
					err = os.Mkdir(path, 0600)
				}
			case "foreign-owner":
				if os.Geteuid() != 0 {
					t.Skip("changing proof owner requires root")
				}
				err = os.Chown(path, 1000, 1000)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := retainedSourceRestore(t, b, actorUID, wire); err == nil {
				t.Fatal("unsafe private import proof admitted retained Source")
			}
		})
	}
}

func TestSubstrateSourceRetainedColdRestoreRejectsAmbiguousLease(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"absent-discriminant": func(w map[string]any) { delete(w, "retained") },
		"false-discriminant":  func(w map[string]any) { w["retained"] = false },
		"null-discriminant":   func(w map[string]any) { w["retained"] = nil },
		"wrong-version":       func(w map[string]any) { w["version"] = 1 },
		"foreign-actor":       func(w map[string]any) { w["actorUID"] = "11345112-f121-4739-b2f3-6c6cf60bd2bf" },
		"missing-owner":       func(w map[string]any) { delete(w, "writerEpoch") },
		"missing-role":        func(w map[string]any) { delete(w, "changeWriterEpoch") },
		"missing-readonly":    func(w map[string]any) { delete(w, "readOnly") },
		"null-readonly":       func(w map[string]any) { w["readOnly"] = nil },
		"missing-checkpoint":  func(w map[string]any) { delete(w, "checkpoint") },
		"checkpoint":          func(w map[string]any) { w["checkpoint"] = sourceSeedRestoreJSON()["checkpoint"] },
		"actor-provenance":    func(w map[string]any) { w["checkpointActorUID"] = w["actorUID"] },
		"seed-provenance":     func(w map[string]any) { w["checkpointSeedID"] = w["actorUID"] },
		"input-stop":          func(w map[string]any) { w["inputStop"] = ownedInputStop(); w["readOnly"] = true },
	} {
		t.Run(name, func(t *testing.T) {
			b, actorUID, proof, wire := retainedSourceFixture(t)
			writeRetainedSourceProof(t, b, proof)
			unchanged := retainedSourceUnchanged(t, b.Assignment.WorkspaceFolder)
			defer unchanged()
			mutate(wire)
			if err := retainedSourceRestore(t, b, actorUID, wire); err == nil {
				t.Fatal("ambiguous retained lease admitted cold Work")
			}
		})
	}
}
