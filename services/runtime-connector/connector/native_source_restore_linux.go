package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

type sourceRestored struct {
	AttemptID         string           `json:"attemptID"`
	Generation        uint64           `json:"generation"`
	ActorUID          string           `json:"actorUID"`
	WriterEpoch       uint64           `json:"writerEpoch"`
	ChangeWriterEpoch uint64           `json:"changeWriterEpoch"`
	ReadOnly          bool             `json:"readOnly"`
	InputStop         *nativeInputStop `json:"inputStop,omitempty"`
}
type sourceRestoreCheckpoint struct {
	ID          string                `json:"id"`
	WorkspaceID string                `json:"workspaceID"`
	ActorUID    string                `json:"actorUID"`
	SeedID      *string               `json:"seedID,omitempty"`
	WriterEpoch uint64                `json:"writerEpoch"`
	Generation  uint64                `json:"generation"`
	Bundle      workspacefiles.Bundle `json:"bundle"`
}
type sourceRestoreResponse struct {
	Version            int                      `json:"version"`
	ActorUID           string                   `json:"actorUID"`
	CheckpointActorUID string                   `json:"checkpointActorUID"`
	CheckpointSeedID   *string                  `json:"checkpointSeedID"`
	WriterEpoch        uint64                   `json:"writerEpoch"`
	ChangeWriterEpoch  uint64                   `json:"changeWriterEpoch"`
	ReadOnly           bool                     `json:"readOnly"`
	Checkpoint         *sourceRestoreCheckpoint `json:"checkpoint"`
	InputStop          *nativeInputStop         `json:"inputStop,omitempty"`
}

var sourceRestoreUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func validateSourceRestoreLease(reply sourceRestoreResponse, workspaceID, actorUID string, generation uint64) error {
	if reply.Version != 2 || reply.ActorUID != actorUID || !sourceRestoreUUID.MatchString(actorUID) || generation == 0 ||
		reply.WriterEpoch == 0 || reply.ChangeWriterEpoch == 0 || reply.Checkpoint == nil {
		return errors.New("Source restore lease invalid")
	}
	saved := reply.Checkpoint
	if reply.InputStop != nil && (reply.InputStop.validate() != nil || !reply.ReadOnly ||
		reply.InputStop.Mode != "interrupt" || reply.CheckpointActorUID != actorUID) {
		return errors.New("input Stop requires the original read-only Source checkpoint")
	}
	bundle := saved.Bundle
	// Factory binds this checkpoint's producer to the current Source lease.
	// A fresh Actor may consume its positively stopped predecessor's export;
	// it never adopts that Actor's runtime identity or resumes its snapshot.
	actorCheckpoint := saved.ActorUID == reply.CheckpointActorUID && sourceRestoreUUID.MatchString(saved.ActorUID) &&
		saved.SeedID == nil && reply.CheckpointSeedID == nil
	// Factory proves that no predecessor acquired Source before admitting a seed,
	// including successors of stopped, never-granted Actors. Generation alone
	// cannot establish that proof. A Stop-only restore still requires its Actor.
	seedCheckpoint := saved.ActorUID == "" && reply.CheckpointActorUID == "" &&
		saved.SeedID != nil && reply.CheckpointSeedID != nil && *saved.SeedID == *reply.CheckpointSeedID &&
		sourceRestoreUUID.MatchString(*saved.SeedID) && reply.InputStop == nil
	if !actorCheckpoint && !seedCheckpoint {
		return errors.New("Source restore checkpoint provenance invalid")
	}
	if saved.WorkspaceID != workspaceID || !sourceRestoreUUID.MatchString(saved.ID) || saved.Generation == 0 ||
		saved.WriterEpoch != reply.WriterEpoch-1 || bundle.Version != 1 || bundle.Bytes <= 0 ||
		bundle.Bytes > workspacefiles.MaxSourceBundleBytes ||
		len(bundle.Chunks) != int((bundle.Bytes+workspacefiles.SourceChunkBytes-1)/workspacefiles.SourceChunkBytes) {
		return errors.New("Source restore identity/fidelity invalid")
	}
	return nil
}

func sameSourceRestoreLease(current, original sourceRestoreResponse) bool {
	// Policy may advance while the same immutable Source is imported. The
	// final commit ACK, not either GET, supplies the role for native admission.
	current.ChangeWriterEpoch, current.ReadOnly = original.ChangeWriterEpoch, original.ReadOnly
	return reflect.DeepEqual(current, original)
}

// Every request is an authenticated read of the same immutable checkpoint.
// Transient control-plane outages may delay cold startup, but must not replay
// lifecycle work or start Docker against the old Source. Native wakeup supervision
// and caller cancellation bound the wait.
func readSubstrateSourceRestore(ctx context.Context, client *http.Client, request *http.Request) ([]byte, error) {
	if request.Method != http.MethodGet || request.URL.Scheme != "https" {
		return nil, errors.New("Source restore requires an authenticated HTTPS read")
	}
	delay := 100 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		response, err := client.Do(request.Clone(ctx))
		if err == nil {
			if response.StatusCode == http.StatusOK {
				body, readErr := io.ReadAll(io.LimitReader(response.Body, workspacefiles.SourceChunkBytes+1))
				response.Body.Close()
				if len(body) > workspacefiles.SourceChunkBytes {
					return nil, errors.New("Source restore body exceeds bound")
				}
				if readErr == nil {
					return body, nil
				}
			} else {
				response.Body.Close()
				if response.StatusCode != http.StatusBadGateway && response.StatusCode != http.StatusServiceUnavailable && response.StatusCode != http.StatusGatewayTimeout {
					return nil, errors.New("Source restore grant/generation unavailable")
				}
			}
		} else {
			var invalid *tls.CertificateVerificationError
			if errors.As(err, &invalid) {
				return nil, errors.New("Source restore serving identity is invalid")
			}
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, time.Second)
	}
}

// Unlike checkpoint reads, this is a mutation with a possibly lost ACK. Retry
// only these fixed bytes and identity, never lease acquisition or materialization.
// Only an exact ACK may replace the lease's role with its current committed role.
func commitSubstrateSourceRestore(ctx context.Context, client *http.Client, lease *http.Request, reply *sourceRestoreResponse) error {
	if lease.Method != http.MethodGet || lease.URL.Scheme != "https" || reply == nil || reply.Checkpoint == nil || reply.Version != 2 {
		return errors.New("Source restore commit requires its authenticated HTTPS v2 lease")
	}
	payload, err := json.Marshal(struct {
		CheckpointID string `json:"checkpointID"`
		WriterEpoch  uint64 `json:"writerEpoch"`
	}{reply.Checkpoint.ID, reply.WriterEpoch})
	if err != nil {
		return err
	}
	type acknowledgement struct {
		Version      int    `json:"version"`
		ActorUID     string `json:"actorUID"`
		CheckpointID string `json:"checkpointID"`
		WriterEpoch  uint64 `json:"writerEpoch"`
	}
	expected := acknowledgement{2, reply.ActorUID, reply.Checkpoint.ID, reply.WriterEpoch}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	delay := 100 * time.Millisecond
	for attempt := 0; attempt < 5; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, lease.URL.String(), bytes.NewReader(payload))
		if err != nil {
			return err
		}
		request.Header = lease.Header.Clone()
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err == nil {
			if response.StatusCode == http.StatusOK {
				body, readErr := io.ReadAll(io.LimitReader(response.Body, 4097))
				response.Body.Close()
				if len(body) > 4096 {
					return errors.New("Source restore commit ACK exceeds bound")
				}
				if readErr == nil {
					var ack struct {
						acknowledgement
						ChangeWriterEpoch uint64 `json:"changeWriterEpoch"`
						ReadOnly          *bool  `json:"readOnly"`
					}
					d := json.NewDecoder(bytes.NewReader(body))
					d.DisallowUnknownFields()
					if d.Decode(&ack) != nil || d.Decode(new(any)) != io.EOF || ack.acknowledgement != expected ||
						ack.ChangeWriterEpoch == 0 || ack.ReadOnly == nil || (reply.InputStop != nil && !*ack.ReadOnly) {
						return errors.New("Source restore commit ACK differs")
					}
					if err := ctx.Err(); err != nil {
						return err
					}
					reply.ChangeWriterEpoch, reply.ReadOnly = ack.ChangeWriterEpoch, *ack.ReadOnly
					return nil
				}
				err = readErr
			} else {
				response.Body.Close()
				if response.StatusCode != http.StatusBadGateway && response.StatusCode != http.StatusServiceUnavailable && response.StatusCode != http.StatusGatewayTimeout {
					return errors.New("Source restore commit authority unavailable")
				}
			}
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			var invalid *tls.CertificateVerificationError
			var record tls.RecordHeaderError
			var alert tls.AlertError
			var remote *net.OpError
			if errors.As(err, &invalid) || errors.As(err, &record) || errors.As(err, &alert) ||
				(errors.As(err, &remote) && remote.Op == "remote error") {
				return errors.New("Source restore commit serving identity is invalid")
			}
			var requestError *url.Error
			if errors.As(err, &requestError) {
				err = requestError.Err
			}
			var network net.Error
			if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.As(err, &network) {
				return errors.New("Source restore commit transport rejected")
			}
		}
		if attempt == 4 {
			break
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay *= 2
	}
	return errors.New("Source restore commit unconfirmed")
}

// Invoked inside the verified RootlessKit namespace BEFORE dockerd. Neither a
// retained container restart policy nor a watcher/Agent can race this import.
func RunSubstrateSourceRestore(ctx context.Context) error {
	var b bootstrap
	d := json.NewDecoder(strings.NewReader(os.Getenv("FACTORY_SUBSTRATE_BOOTSTRAP")))
	d.DisallowUnknownFields()
	if d.Decode(&b) != nil || b.Assignment.Validate() != nil {
		return errors.New("invalid Source cold bootstrap")
	}
	if !b.SourceHandoff {
		return nil
	}
	if os.Geteuid() != 0 || b.Assignment.WorkspaceFolder != "/home/rootless/persist/project" || b.Assignment.ConnectorStateDir != "/home/rootless/persist/connector" {
		return errors.New("Source restore requires its private native root")
	}
	if err := workspacefiles.ValidateActorSourceIdentity("/home/rootless/persist"); err != nil {
		return err
	}
	uidBytes, err := os.ReadFile("/run/ate/identity/uid")
	actorUID := strings.TrimSpace(string(uidBytes))
	if err != nil || len(actorUID) != 36 {
		return errors.New("Source restore Actor UID unavailable")
	}
	trust, err := os.ReadFile(os.Getenv("SSL_CERT_FILE"))
	if err != nil {
		return errors.New("Source restore trust unavailable")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(append(append(trust, '\n'), []byte(b.FactoryCA)...)) {
		return errors.New("Source restore serving CA invalid")
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	endpoint, err := url.Parse(b.Assignment.ControlURL)
	if err != nil || endpoint.Scheme != "wss" {
		return errors.New("Source restore requires authenticated HTTPS")
	}
	endpoint.Scheme = "https"
	endpoint.Path = "/internal/substrate-source/" + b.Assignment.RuntimeAttemptID
	endpoint.RawQuery = ""
	return restoreSubstrateSource(ctx, b, actorUID, client, endpoint)
}

func restoreSubstrateSource(ctx context.Context, b bootstrap, actorUID string, client *http.Client, endpoint *url.URL) error {
	// A marker from a preceding cold start cannot admit execution on an uncertain
	// commit, even if this invocation is not entered through the normal launcher.
	if err := os.Remove(filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	lease, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return err
	}
	lease.Header.Set("Authorization", "Bearer "+b.ParentToken)
	lease.Header.Set("X-Factory-Runtime-Actor-UID", actorUID)
	lease.Header.Set("X-Factory-Runtime-Generation", fmt.Sprint(b.Assignment.Generation))
	lease.Header.Set("X-Factory-Source-Protocol", "2")
	request := func(query string, epoch uint64) ([]byte, error) {
		u := *endpoint
		u.RawQuery = query
		r := lease.Clone(ctx)
		r.URL = &u
		if epoch != 0 {
			r.Header.Set("X-Factory-Source-Writer-Epoch", fmt.Sprint(epoch))
		}
		return readSubstrateSourceRestore(ctx, client, r)
	}
	finishLease := startupPhase("source-restore-lease")
	data, err := request("", 0)
	finishLease()
	if err != nil {
		return err
	}
	var reply sourceRestoreResponse
	if json.Unmarshal(data, &reply) != nil {
		return errors.New("Source restore lease invalid")
	}
	if err := validateSourceRestoreLease(reply, b.Source.WorkspaceID, actorUID, b.Assignment.Generation); err != nil {
		return err
	}
	// b.InputStop advertises the bootstrap's capability, not a dispatched Stop.
	// Only the authenticated reply's actual InputStop excludes a seed above.
	if reply.InputStop != nil && (b.InputStop == nil || b.InputStop.Version != 1 ||
		b.InputStop.OpenCodeVersion != reply.InputStop.Version || reply.InputStop.AttemptID != b.Assignment.RuntimeAttemptID) {
		return errors.New("input Stop differs from its admitted cold bootstrap")
	}
	if saved := reply.Checkpoint; saved != nil {
		finishDownload := startupPhase("source-restore-download")
		bundle := saved.Bundle
		staging, err := os.MkdirTemp(filepath.Dir(b.Assignment.WorkspaceFolder), ".factory-source-restore-")
		if err != nil {
			return errors.New("private Source staging unavailable")
		}
		file, err := os.OpenFile(filepath.Join(staging, "source.tar"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		defer file.Close()
		hash := sha256.New()
		for i, expected := range bundle.Chunks {
			chunk, err := request(url.Values{"chunk": {fmt.Sprint(i)}, "checkpoint": {saved.ID}}.Encode(), reply.WriterEpoch)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(chunk)
			if hex.EncodeToString(digest[:]) != expected || int64(len(chunk)) != min(int64(workspacefiles.SourceChunkBytes), bundle.Bytes-int64(i)*workspacefiles.SourceChunkBytes) {
				return errors.New("Source restore chunk is incomplete or corrupt")
			}
			hash.Write(chunk)
			if _, err := file.Write(chunk); err != nil {
				return err
			}
		}
		if hex.EncodeToString(hash.Sum(nil)) != bundle.SHA256 {
			return errors.New("Source restore complete checksum differs")
		}
		if err := file.Sync(); err != nil {
			return err
		}
		finishDownload()
		project := filepath.Join(staging, "project")
		finishMaterialize := startupPhase("source-restore-materialize")
		err = workspacefiles.MaterializeBundle(file, project)
		finishMaterialize()
		if err != nil {
			return errors.New("Source metadata/materialization rejected; old data retained")
		}
		git := exec.CommandContext(ctx, "git", "-c", "safe.directory="+project, "-C", project, "config", "--no-includes", "--local", "--get", "factory.repositoryIdentity")
		git.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		identity, err := git.Output()
		if err != nil || strings.TrimSpace(string(identity)) != b.Source.ProjectID {
			return errors.New("restored Source Project identity differs")
		}
		// Recheck the live epoch after downloading; a stale bootstrap cannot publish.
		latest, err := request("", 0)
		if err != nil {
			return err
		}
		var current sourceRestoreResponse
		if json.Unmarshal(latest, &current) != nil ||
			validateSourceRestoreLease(current, b.Source.WorkspaceID, actorUID, b.Assignment.Generation) != nil ||
			!sameSourceRestoreLease(current, reply) {
			return errors.New("Source owner changed before publication")
		}
		canonical := b.Assignment.WorkspaceFolder
		if info, err := os.Lstat(canonical); err == nil {
			if !info.IsDir() {
				return errors.New("existing Source root is unsupported; retained")
			}
			retained := filepath.Join(staging, "retained-project")
			if err := os.Rename(canonical, retained); err != nil {
				return errors.New("old Source could not be retained")
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(project, canonical); err != nil {
			return errors.New("Source publication failed; retained tree remains in private staging")
		}
	}
	if err := commitSubstrateSourceRestore(ctx, client, lease, &reply); err != nil {
		return err
	}
	if err := os.MkdirAll(b.Assignment.ConnectorStateDir, 0700); err != nil {
		return err
	}
	marker, _ := json.Marshal(sourceRestored{AttemptID: b.Assignment.RuntimeAttemptID, Generation: b.Assignment.Generation, ActorUID: actorUID, WriterEpoch: reply.WriterEpoch, ChangeWriterEpoch: reply.ChangeWriterEpoch, ReadOnly: reply.ReadOnly, InputStop: reply.InputStop})
	temporary, err := os.CreateTemp(b.Assignment.ConnectorStateDir, ".source-restored-")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(marker); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	temporary.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json"))
}
