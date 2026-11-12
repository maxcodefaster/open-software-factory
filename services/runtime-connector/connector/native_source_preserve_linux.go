package connector

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

var sourcePreservationUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type sourcePreservation struct {
	ActorUID          string                `json:"actorUID"`
	CheckpointID      string                `json:"checkpointID"`
	Archive           string                `json:"archive"`
	Bundle            workspacefiles.Bundle `json:"bundle"`
	PredecessorSHA256 string                `json:"predecessorSHA256,omitempty"`
}

// One-shot operator preservation of already-fenced Source. This command has no
// native lifecycle, Factory credentials, network, Docker, Git or Project process
// dispatch. Its caller must hold the existing Workspace lock and positively
// confirm the exact Source fence and completed private-writer drain. This is not
// an editor, Source-owner transfer, snapshot or permission to repeat a pause.
func RunSubstrateSourcePreserve(actorUID, checkpointID string, output io.Writer) error {
	return preserveSubstrateSource(actorUID, checkpointID, "", output)
}

// Reconcile only the positively completed first archive, not a running or lost
// export. Keep it intact and create one separately named copy with the bounded
// mapped reader. The original Source fence and checkpoint identity do not change.
func RunSubstrateSourcePreserveReconciled(actorUID, checkpointID, predecessorSHA256 string, output io.Writer) error {
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(predecessorSHA256) {
		return errors.New("completed Source preservation checksum is required")
	}
	return preserveSubstrateSource(actorUID, checkpointID, predecessorSHA256, output)
}

func preserveSubstrateSource(actorUID, checkpointID, predecessorSHA256 string, output io.Writer) error {
	const parent = "/home/rootless/persist"
	if err := workspacefiles.ValidateActorSourceIdentity(parent); err != nil {
		return err
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || !sourcePreservationUUID.MatchString(actorUID) || strings.TrimSpace(string(uid)) != actorUID || !sourcePreservationUUID.MatchString(checkpointID) {
		return errors.New("retained Source preservation identity is unavailable")
	}
	directory := filepath.Join(parent, "connector")
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || info.Sys().(*syscall.Stat_t).Uid != 0 {
		return errors.New("retained Source preservation private directory is unavailable")
	}
	// An existing operation is retained, never removed or re-exported implicitly.
	operation := filepath.Join(directory, "source-preservation-"+checkpointID)
	if predecessorSHA256 != "" {
		data, err := os.ReadFile(filepath.Join(operation, "recovery.json"))
		var prior sourcePreservation
		if err != nil || json.Unmarshal(data, &prior) != nil || prior.ActorUID != actorUID || prior.CheckpointID != checkpointID || prior.Archive != filepath.Join(operation, "source.tar") || prior.Bundle.Version != 2 || prior.Bundle.SHA256 != predecessorSHA256 || prior.PredecessorSHA256 != "" {
			return errors.New("original completed Source preservation identity is unavailable; no export repeated")
		}
		original, err := os.Open(prior.Archive)
		if err != nil {
			return errors.New("original preservation archive is unavailable")
		}
		observed, err := workspacefiles.InspectBundle(original)
		original.Close()
		observed.Version = 2
		if err != nil || !reflect.DeepEqual(observed, prior.Bundle) {
			return errors.New("original completed preservation archive checksum differs")
		}
		operation += "-noatime"
	}
	if err := os.Mkdir(operation, 0700); err != nil {
		return errors.New("retained Source preservation already exists or could not be admitted")
	}
	file, err := os.OpenFile(filepath.Join(operation, "source.tar"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return errors.New("private Source preservation archive is unavailable")
	}
	defer file.Close()
	view, closeView, err := nativeArchiveView(filepath.Join(operation, "source-archive-view"))
	if err != nil {
		return err
	}
	defer closeView()
	source, err := workspacefiles.OpenDescriptor(view)
	if err != nil {
		return errors.New("original Source is unavailable")
	}
	defer source.Close()
	bundle, err := source.ExportRetainedLockfileBundle(file)
	if err != nil {
		return errors.New("complete retained Source preservation failed; original Source unchanged")
	}
	// Prove the recovery copy, including root metadata, without publishing it or
	// starting any process against it. A failed proof retains all partial data.
	restored := filepath.Join(operation, "project")
	if err := workspacefiles.MaterializeRetainedLockfileBundle(file, restored); err != nil {
		return errors.New("retained Source recovery-copy validation failed")
	}
	copySource, err := workspacefiles.Open(restored)
	if err != nil {
		return err
	}
	defer copySource.Close()
	copyArchive, err := os.OpenFile(filepath.Join(operation, "roundtrip.tar"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer copyArchive.Close()
	copyBundle, err := copySource.ExportRetainedLockfileBundle(copyArchive)
	if err != nil || !reflect.DeepEqual(bundle, copyBundle) {
		return errors.New("retained Source metadata/bytes differ after private recovery round trip")
	}
	recheck, err := os.OpenFile(filepath.Join(operation, "recheck.tar"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer recheck.Close()
	current, err := source.ExportRetainedLockfileBundle(recheck)
	if err != nil || !reflect.DeepEqual(bundle, current) {
		return errors.New("original Source metadata changed during preservation; no recovery reference published")
	}
	result := sourcePreservation{ActorUID: actorUID, CheckpointID: checkpointID, Archive: filepath.Join(operation, "source.tar"), Bundle: bundle, PredecessorSHA256: predecessorSHA256}
	// Functional recovery identity, not a lifecycle or Source confirmation marker.
	manifest, err := os.OpenFile(filepath.Join(operation, "recovery.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(manifest).Encode(result)
	if err == nil {
		err = manifest.Sync()
	}
	manifest.Close()
	if err != nil {
		return err
	}
	dir, err := os.Open(operation)
	if err != nil {
		return err
	}
	err = dir.Sync()
	dir.Close()
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
