// The concrete native cold entrypoint. No saved commands or model work are read.
package connector

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

type bootstrap struct {
	InputStop *struct {
		Version         int    `json:"version"`
		OpenCodeVersion string `json:"openCodeVersion"`
	} `json:"inputStop,omitempty"`
	ProjectTemplate *nativeProjectTemplate        `json:"projectTemplate,omitempty"`
	SourceHandoff   bool                          `json:"sourceHandoff,omitempty"`
	Assignment      Assignment                    `json:"assignment"`
	Source          workspacefiles.Initialization `json:"source"`
	ParentToken     string                        `json:"parentToken"`
	ChildToken      string                        `json:"childToken"`
	FactoryCA       string                        `json:"factoryCA"`
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
		restored.InputStop.Validate() != nil || restored.InputStop.AttemptID != restored.AttemptID ||
		restored.InputStop.Version != b.InputStop.OpenCodeVersion || !restored.ReadOnly) {
		return restored, errors.New("input Stop cold admission is invalid")
	}
	return restored, nil
}

func selectNativeBootstrapTrust(b bootstrap, prepare bool) (string, error) {
	if b.Assignment.WorkspaceFolder != "/var/lib/factory/source/project" ||
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
	if b.Assignment.WorkspaceFolder != "/var/lib/factory/source/project" || b.Assignment.ConnectorStateDir != nativeBootstrapStateDirectory || !b.Assignment.PreserveWorkspace ||
		b.Source.ProjectID != b.Assignment.RepositoryIdentity || b.Source.Revision != b.Assignment.Revision || b.Source.RepositoryURL != b.Assignment.RepositoryURL || b.ParentToken == "" || b.ChildToken == "" {
		return errors.New("native Source and runtime assignment differ")
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || len(strings.TrimSpace(string(uid))) != 36 {
		return errors.New("native Actor UID is unavailable")
	}
	os.Setenv("FACTORY_SUBSTRATE_ACTOR_UID", strings.TrimSpace(string(uid)))
	if err := workspacefiles.ValidateActorSourceIdentity("/var/lib/factory/source"); err != nil {
		return err
	}
	for path, mode := range map[string]os.FileMode{
		nativeBootstrapStateDirectory: 0700,
		"/var/lib/factory/source":     0755,
		nativeProjectTrustDirectory:   0755,
		nativeSkillsControlDirectory:  0755,
	} {
		var state unix.Stat_t
		if unix.Lstat(path, &state) != nil || state.Mode&unix.S_IFMT != unix.S_IFDIR ||
			state.Uid != 0 || state.Gid != 0 {
			return errors.New("native controller volume owner is unavailable")
		}
		// Native durable directories may initially be world-writable. Tighten
		// only these fixed, root-owned Factory mounts before any entry grant.
		if err := os.Chmod(path, mode); err != nil {
			return err
		}
	}
	ca, err := selectNativeBootstrapTrust(b, true)
	if err != nil {
		return err
	}
	os.Setenv("SSL_CERT_FILE", ca)
	os.Setenv("GIT_SSL_CAINFO", ca)
	os.Setenv("NODE_EXTRA_CA_CERTS", ca)
	os.Setenv("FACTORY_CONNECTOR_CA_FILE", ca)
	if err := publishNativeProjectTrust(ca); err != nil {
		return err
	}
	var restored sourceRestored
	if b.SourceHandoff {
		if err := restoreSubstrateBootstrap(ctx, b); err != nil {
			return err
		}
		restored, err = readNativeRestored(b, strings.TrimSpace(string(uid)))
		if err != nil {
			return err
		}
		if restored.InputStop != nil {
			return errors.New("native Work remains fenced for its recorded input Stop")
		}
	}
	initCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	err = workspacefiles.InitializeActor(initCtx, "/var/lib/factory/source", b.Source)
	cancel()
	if err != nil {
		return err
	}
	if !b.SourceHandoff {
		if err := verifyNativeProjectTemplate(b.Assignment.WorkspaceFolder, b.Assignment.ActorTemplatePath, b.ProjectTemplate); err != nil {
			return err
		}
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
	owner := &nativeSourceOwner{service: handler, stop: closeSource}
	owner.epoch.Store(ownerEpoch)
	owner.ready.Store(true)
	defer owner.close()
	b.Assignment.SetNativeSource(owner)
	b.Assignment.SetNativeActorUID(strings.TrimSpace(string(uid)))
	err = runNativeController(ctx, b.Assignment, b.ParentToken, owner)
	if parentContext.Err() == nil && ctx.Err() != nil {
		return errors.New("native Source process exited; canonical access was revoked")
	}
	return err
}

func publishNativeProjectTrust(private string) error {
	var directory unix.Stat_t
	if unix.Lstat(nativeProjectTrustDirectory, &directory) != nil ||
		directory.Mode&unix.S_IFMT != unix.S_IFDIR || directory.Uid != 0 ||
		directory.Gid != 0 || directory.Mode&0022 != 0 {
		return errors.New("native public trust volume owner is invalid")
	}
	content, err := os.ReadFile(private)
	if err != nil || !nativeBootstrapCertificates(content) {
		return errors.New("native public trust bytes are invalid")
	}
	file, err := os.CreateTemp(nativeProjectTrustDirectory, ".trust-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0644); err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), nativeProjectTrustFile)
}

// Only Factory control and Source operations live here. Substrate owns Project
// containers; this process never starts, supervises or stops a container daemon.
func runNativeController(ctx context.Context, assignment Assignment, token string, source *nativeSourceOwner) error {
	var ready atomic.Bool
	server := &http.Server{Addr: ":18081", ReadHeaderTimeout: time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/readyz" || !ready.Load() || !source.ready.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusOK)
		})}
	listener, err := net.Listen("tcp4", server.Addr)
	if err != nil {
		return errors.New("native controller readiness listener is unavailable")
	}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	stop := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer stop()
	fence := &parentSourceFence{}
	handle := fence.Wrap(func(ctx context.Context, message Message) Message {
		if message.Action == "source-drain" {
			// Factory has already obtained Work's synchronous writer barrier.
			// The existing Parent fence also joins its own serialized Git work.
			response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
			if message.Data != message.OperationID {
				response.Error = "native Work writer barrier is unconfirmed"
			}
			return response
		}
		switch message.Action {
		case "browser-inspection":
			return handleNativeBrowserInspection(ctx, assignment, source, message)
		case "skills-install":
			return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action,
				Error: errorText(installAdmittedSkills(ctx, assignment, message.Data))}
		case "workspace-git", "git-prepare-commit", "git-observe-commit", "git-prepare-integration", "git-push":
			return handleParentOperation(ctx, assignment, message)
		default:
			return Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action,
				Error: "operation requires its native Work or isolated browser owner"}
		}
	})
	operations := startParentOperations(ctx, handle)
	defer operations.stop()
	var backoff reconnectBackoff
	for ctx.Err() == nil {
		control, err := dialControl(ctx, assignment, "parent", token)
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(backoff.Next()):
				continue
			}
		}
		connected, disconnect := context.WithCancel(ctx)
		closeOnCancel := context.AfterFunc(ctx, func() { _ = control.Close() })
		hello := Message{Type: "hello", Role: "parent", AttemptID: assignment.RuntimeAttemptID, Generation: assignment.Generation}
		if source.ready.Load() {
			hello.Channels = parentChannels(assignment)
			epoch := source.epoch.Load()
			hello.SourceEpoch = &epoch
		}
		err = control.Write(hello)
		if err == nil {
			err = control.Write(Message{Type: "status", Phase: "child-started"})
		}
		streams := newParentSourceStreams(assignment.NativeSource())
		ready.Store(err == nil)
		backoff.Reset()
		for err == nil {
			var message Message
			err = control.Read(&message)
			if err != nil {
				break
			}
			switch message.Type {
			case "stop":
				_ = control.Write(Message{Type: "status", Phase: "stopping"})
				ready.Store(false)
				disconnect()
				closeOnCancel()
				control.Close()
				return nil
			case "http-request":
				streams.Start(connected, control, message)
			case "stream-close":
				streams.Close(message.StreamID)
			case "operation-request":
				if !operations.submit(control, message) {
					_ = control.Write(Message{Type: "operation-response", OperationID: message.OperationID,
						Action: message.Action, Error: "native controller operation queue is full"})
				}
			}
		}
		ready.Store(false)
		disconnect()
		closeOnCancel()
		control.Close()
	}
	return nil
}
