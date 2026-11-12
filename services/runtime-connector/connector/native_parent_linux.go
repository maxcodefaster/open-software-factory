// The concrete native cold entrypoint. No saved commands or model work are read.
package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

type bootstrap struct {
	SourceHandoff bool                          `json:"sourceHandoff,omitempty"`
	Assignment    Assignment                    `json:"assignment"`
	Source        workspacefiles.Initialization `json:"source"`
	ParentToken   string                        `json:"parentToken"`
	ChildToken    string                        `json:"childToken"`
	FactoryCA     string                        `json:"factoryCA"`
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
	trust, err := os.ReadFile(os.Getenv("SSL_CERT_FILE"))
	if err != nil {
		return errors.New("native trust projection is unavailable")
	}
	if !strings.Contains(b.FactoryCA, "-----BEGIN CERTIFICATE-----") || strings.Contains(b.FactoryCA, "PRIVATE KEY") {
		return errors.New("Factory serving CA is invalid")
	}
	if err := os.MkdirAll(b.Assignment.ConnectorStateDir, 0700); err != nil {
		return err
	}
	ca := filepath.Join(b.Assignment.ConnectorStateDir, "trust.pem")
	if err := os.WriteFile(ca, append(append(trust, '\n'), []byte(b.FactoryCA)...), 0600); err != nil {
		return err
	}
	os.Setenv("SSL_CERT_FILE", ca)
	os.Setenv("GIT_SSL_CAINFO", ca)
	os.Setenv("NODE_EXTRA_CA_CERTS", ca)
	os.Setenv("FACTORY_CONNECTOR_CA_FILE", ca)
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
		var restored sourceRestored
		file, readErr := os.ReadFile(filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json"))
		if readErr != nil || json.Unmarshal(file, &restored) != nil || restored.ActorUID != strings.TrimSpace(string(uid)) || restored.WriterEpoch == 0 || restored.ChangeWriterEpoch == 0 {
			return errors.New("Source was not restored before Docker startup")
		}
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
