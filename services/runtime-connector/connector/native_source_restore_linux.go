package connector

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

type sourceRestored struct {
	ActorUID          string `json:"actorUID"`
	WriterEpoch       uint64 `json:"writerEpoch"`
	ChangeWriterEpoch uint64 `json:"changeWriterEpoch"`
	ReadOnly          bool   `json:"readOnly"`
}
type sourceRestoreCheckpoint struct {
	ID          string                `json:"id"`
	WorkspaceID string                `json:"workspaceID"`
	ActorUID    string                `json:"actorUID"`
	WriterEpoch uint64                `json:"writerEpoch"`
	Generation  uint64                `json:"generation"`
	Bundle      workspacefiles.Bundle `json:"bundle"`
}
type sourceRestoreResponse struct {
	WriterEpoch       uint64                   `json:"writerEpoch"`
	ChangeWriterEpoch uint64                   `json:"changeWriterEpoch"`
	ReadOnly          bool                     `json:"readOnly"`
	Checkpoint        *sourceRestoreCheckpoint `json:"checkpoint"`
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
	request := func(query string, epoch uint64) ([]byte, error) {
		u := *endpoint
		u.RawQuery = query
		r, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if err != nil {
			return nil, err
		}
		r.Header.Set("Authorization", "Bearer "+b.ParentToken)
		r.Header.Set("X-Factory-Runtime-Actor-UID", actorUID)
		r.Header.Set("X-Factory-Runtime-Generation", fmt.Sprint(b.Assignment.Generation))
		if epoch != 0 {
			r.Header.Set("X-Factory-Source-Writer-Epoch", fmt.Sprint(epoch))
		}
		return readSubstrateSourceRestore(ctx, client, r)
	}
	data, err := request("", 0)
	if err != nil {
		return err
	}
	var reply sourceRestoreResponse
	if json.Unmarshal(data, &reply) != nil || reply.WriterEpoch == 0 || reply.ChangeWriterEpoch == 0 {
		return errors.New("Source restore lease invalid")
	}
	if saved := reply.Checkpoint; saved != nil {
		bundle := saved.Bundle
		if saved.WorkspaceID != b.Source.WorkspaceID || saved.ActorUID != actorUID || saved.ID == "" || saved.Generation == 0 || saved.WriterEpoch >= reply.WriterEpoch || bundle.Version != 1 || bundle.Bytes <= 0 || bundle.Bytes > workspacefiles.MaxSourceBundleBytes || len(bundle.Chunks) != int((bundle.Bytes+workspacefiles.SourceChunkBytes-1)/workspacefiles.SourceChunkBytes) {
			return errors.New("Source restore identity/fidelity invalid")
		}
		staging, err := os.MkdirTemp("/home/rootless/persist", ".factory-source-restore-")
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
		project := filepath.Join(staging, "project")
		if err := workspacefiles.MaterializeBundle(file, project); err != nil {
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
		if json.Unmarshal(latest, &current) != nil || current.WriterEpoch != reply.WriterEpoch || current.ChangeWriterEpoch != reply.ChangeWriterEpoch || current.ReadOnly != reply.ReadOnly || current.Checkpoint == nil || current.Checkpoint.ID != saved.ID {
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
	if err := os.MkdirAll(b.Assignment.ConnectorStateDir, 0700); err != nil {
		return err
	}
	marker, _ := json.Marshal(sourceRestored{ActorUID: actorUID, WriterEpoch: reply.WriterEpoch, ChangeWriterEpoch: reply.ChangeWriterEpoch, ReadOnly: reply.ReadOnly})
	temporary, err := os.CreateTemp(b.Assignment.ConnectorStateDir, ".source-restored-")
	if err != nil {
		return err
	}
	if _, err := temporary.Write(marker); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	temporary.Close()
	return os.Rename(temporary.Name(), filepath.Join(b.Assignment.ConnectorStateDir, "source-restored.json"))
}
