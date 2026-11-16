// The concrete native cold entrypoint. No saved commands or model work are read.
package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

type bootstrap struct {
	InputStop *struct {
		Version         int    `json:"version"`
		OpenCodeVersion string `json:"openCodeVersion"`
	} `json:"inputStop,omitempty"`
	SourceHandoff bool                          `json:"sourceHandoff,omitempty"`
	Assignment    Assignment                    `json:"assignment"`
	Source        workspacefiles.Initialization `json:"source"`
	ParentToken   string                        `json:"parentToken"`
	ChildToken    string                        `json:"childToken"`
	FactoryCA     string                        `json:"factoryCA"`
}

func readNativeRestored(b bootstrap, actorUID string) (sourceRestored, error) {
	var restored sourceRestored
	data, err := os.ReadFile(filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json"))
	if err != nil || json.Unmarshal(data, &restored) != nil || restored.ActorUID != actorUID ||
		restored.AttemptID != b.Assignment.RuntimeAttemptID || restored.Generation != b.Assignment.Generation ||
		restored.WriterEpoch == 0 || restored.ChangeWriterEpoch == 0 {
		return restored, errors.New("Source was not restored for this exact cold bootstrap")
	}
	if restored.InputStop != nil && (b.InputStop == nil || b.InputStop.Version != 1 ||
		restored.InputStop.validate() != nil || restored.InputStop.AttemptID != restored.AttemptID ||
		restored.InputStop.Version != b.InputStop.OpenCodeVersion || !restored.ReadOnly) {
		return restored, errors.New("input Stop cold admission is invalid")
	}
	return restored, nil
}

func RunSubstrateBootstrapMode(output io.Writer) error {
	var b bootstrap
	d := json.NewDecoder(strings.NewReader(os.Getenv("FACTORY_SUBSTRATE_BOOTSTRAP")))
	d.DisallowUnknownFields()
	if d.Decode(&b) != nil || b.Assignment.Validate() != nil {
		return errors.New("invalid native cold mode")
	}
	mode := "docker"
	if b.SourceHandoff {
		uid, err := os.ReadFile("/run/ate/identity/uid")
		if err != nil {
			return err
		}
		restored, err := readNativeRestored(b, strings.TrimSpace(string(uid)))
		if err != nil {
			return err
		}
		if restored.InputStop != nil {
			mode = "input-stop"
		}
	}
	// Only the inner cold step may publish. The outer UID-1000 readiness
	// process observes that same file without racing its creation/replacement.
	prepare := os.Geteuid() == 0
	if prepare {
		if err := workspacefiles.ValidateActorSourceIdentity("/home/rootless/persist"); err != nil {
			return err
		}
	} else if os.Geteuid() != 1000 {
		return errors.New("native cold mode requires its private owner")
	}
	if _, err := selectNativeBootstrapTrust(b, prepare); err != nil {
		return err
	}
	_, err := fmt.Fprintln(output, mode)
	return err
}

func selectNativeBootstrapTrust(b bootstrap, prepare bool) (string, error) {
	if b.Assignment.WorkspaceFolder != "/home/rootless/persist/project" ||
		b.Assignment.ConnectorStateDir != nativeBootstrapStateDirectory {
		return "", errors.New("native bootstrap trust requires its fixed private paths")
	}
	// Always read the native projection, never ambient SSL_CERT_FILE or a
	// retained combined bundle. A cold boot must not accumulate old Factory CAs.
	trust, err := os.ReadFile(nativeBootstrapTrustProjection)
	if err != nil {
		return "", errors.New("native trust projection is unavailable")
	}
	return nativeBootstrapTrust(nativeBootstrapStateDirectory, trust, b.FactoryCA, prepare)
}

func RunSubstrateParent(ctx context.Context) error {
	text := os.Getenv("FACTORY_SUBSTRATE_BOOTSTRAP")
	os.Unsetenv("FACTORY_SUBSTRATE_BOOTSTRAP")
	if err := ProtectProcess(); err != nil {
		return err
	}
	var b bootstrap
	d := json.NewDecoder(strings.NewReader(text))
	d.DisallowUnknownFields()
	if len(text) > 1<<20 || d.Decode(&b) != nil {
		return errors.New("invalid native bootstrap assignment")
	}
	if err := b.Assignment.Validate(); err != nil {
		return err
	}
	if b.Assignment.WorkspaceFolder != "/home/rootless/persist/project" || b.Assignment.ConnectorStateDir != "/home/rootless/persist/connector" || !b.Assignment.PreserveWorkspace ||
		b.Source.ProjectID != b.Assignment.RepositoryIdentity || b.Source.Revision != b.Assignment.Revision || b.Source.RepositoryURL != b.Assignment.RepositoryURL || b.ParentToken == "" || b.ChildToken == "" {
		return errors.New("native Source and runtime assignment differ")
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || len(strings.TrimSpace(string(uid))) != 36 {
		return errors.New("native Actor UID is unavailable")
	}
	os.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", strings.TrimSpace(string(uid)))
	ca, err := selectNativeBootstrapTrust(b, false)
	if err != nil {
		return err
	}
	os.Setenv("SSL_CERT_FILE", ca)
	os.Setenv("GIT_SSL_CAINFO", ca)
	os.Setenv("NODE_EXTRA_CA_CERTS", ca)
	os.Setenv("FACTORY_CONNECTOR_CA_FILE", ca)
	var restored sourceRestored
	if b.SourceHandoff {
		restored, err = readNativeRestored(b, strings.TrimSpace(string(uid)))
		if err != nil {
			return err
		}
		if restored.InputStop != nil {
			// This branch precedes checkout/initialization and never calls
			// RunParent, private Docker, Dev Containers or Project hooks.
			return runNativeInputStopParent(ctx, b, restored)
		}
	}
	initCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	err = workspacefiles.InitializeActor(initCtx, "/home/rootless/persist", b.Source)
	cancel()
	if err != nil {
		return err
	}
	parentContext := ctx
	ctx, cancelSource := context.WithCancel(ctx)
	defer cancelSource()
	writerEpoch := uint64(1)
	ownerEpoch := uint64(1)
	readOnly := false
	if b.SourceHandoff {
		ownerEpoch, writerEpoch, readOnly = restored.WriterEpoch, restored.ChangeWriterEpoch, restored.ReadOnly
	}
	handler, closeSource, err := startNativeSource(ctx, b.Source.WorkspaceID, b.Assignment.Generation, ownerEpoch, writerEpoch, readOnly, b.Assignment.ConnectorStateDir, cancelSource)
	if err != nil {
		return err
	}
	defer closeSource()
	b.Assignment.nativeSource = handler
	b.Assignment.nativeActorUID = strings.TrimSpace(string(uid))
	b.Assignment.nativeRetainedSource = b.SourceHandoff
	err = RunParent(ctx, b.Assignment, b.ParentToken, b.ChildToken)
	if parentContext.Err() == nil && ctx.Err() != nil {
		return errors.New("native Source process exited; canonical access was revoked")
	}
	return err
}
