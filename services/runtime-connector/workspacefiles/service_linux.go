package workspacefiles

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type Access struct {
	WorkspaceID string `json:"workspaceId"`
	ServiceID   string `json:"serviceId"`
	Epoch       uint64 `json:"epoch"`
	Token       string `json:"token"`
	WriterEpoch uint64 `json:"writerEpoch,omitempty"`
	OwnerEpoch  uint64 `json:"ownerEpoch,omitempty"`
	ReadOnly    bool   `json:"readOnly,omitempty"`
}

type Service struct {
	source           *Source
	access           Access
	ctx              context.Context
	revoke           context.CancelFunc
	life             sync.RWMutex
	active           bool
	writes           sync.Mutex
	writerEpoch      uint64
	ownerEpoch       uint64
	writable         bool
	checkpointID     string
	checkpointFile   *os.File
	checkpointBundle Bundle
}

var sourceIdentity = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func NewService(source *Source, access Access) (*Service, error) {
	if source == nil || !sourceIdentity.MatchString(access.WorkspaceID) || !sourceIdentity.MatchString(access.ServiceID) ||
		access.Epoch == 0 || len(access.Token) < 32 || len(access.Token) > 256 || strings.ContainsAny(access.Token, "\r\n ") {
		return nil, errors.New("invalid source service assignment")
	}
	ctx, cancel := context.WithCancel(context.Background())
	ownerEpoch := access.OwnerEpoch
	if ownerEpoch == 0 {
		ownerEpoch = access.WriterEpoch
	}
	return &Service{source: source, access: access, ctx: ctx, revoke: cancel, active: true,
		writerEpoch: access.WriterEpoch, ownerEpoch: ownerEpoch,
		writable: access.WriterEpoch != 0 && !access.ReadOnly}, nil
}

// Factory rechecks current human authority before forwarding each operation.
// This service capability is server-only and independent of Runtime Attempts.
func (service *Service) authorized(request *http.Request) bool {
	return service.active &&
		request.Header.Get("X-Factory-Source-Service") == service.access.ServiceID &&
		request.Header.Get("X-Factory-Source-Epoch") == strconv.FormatUint(service.access.Epoch, 10) &&
		subtle.ConstantTimeCompare([]byte(request.Header.Get("Authorization")), []byte("Bearer "+service.access.Token)) == 1
}

func (service *Service) Revoke() {
	service.life.Lock()
	defer service.life.Unlock()
	service.active = false
	service.revoke()
	if service.checkpointFile != nil {
		name := service.checkpointFile.Name()
		service.checkpointFile.Close()
		os.Remove(name)
	}
}

type sourceRequest struct {
	Path         string  `json:"path"`
	Content      []byte  `json:"content,omitempty"`
	Version      string  `json:"version,omitempty"`
	Search       *Search `json:"search,omitempty"`
	Destination  string  `json:"destination,omitempty"`
	Overwrite    bool    `json:"overwrite,omitempty"`
	Recursive    bool    `json:"recursive,omitempty"`
	WriterEpoch  uint64  `json:"writerEpoch,omitempty"`
	Writable     bool    `json:"writable,omitempty"`
	CheckpointID string  `json:"checkpointId,omitempty"`
	Chunk        int     `json:"chunk,omitempty"`
}

func (service *Service) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	service.life.RLock()
	if !service.authorized(request) {
		service.life.RUnlock()
		sourceError(response, http.StatusForbidden, "Source access is unavailable")
		return
	}
	prefix := "/v1/workspaces/" + service.access.WorkspaceID + "/"
	if !strings.HasPrefix(request.URL.Path, prefix) || request.URL.RawQuery != "" {
		service.life.RUnlock()
		sourceError(response, http.StatusNotFound, "Source operation is unavailable")
		return
	}
	operation := strings.TrimPrefix(request.URL.Path, prefix)
	if operation == "events" && request.Method == http.MethodGet {
		service.life.RUnlock() // Revocation must be able to close a long-lived stream.
		service.events(response, request)
		return
	}
	defer service.life.RUnlock()
	if request.Method != http.MethodPost {
		sourceError(response, http.StatusMethodNotAllowed, "Source operation requires POST")
		return
	}
	var input sourceRequest
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 4<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		sourceError(response, http.StatusBadRequest, "Invalid source request")
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		sourceError(response, http.StatusBadRequest, "Invalid source request")
		return
	}
	if operation == "checkpoint" || operation == "chunk" {
		service.writes.Lock()
		defer service.writes.Unlock()
		if !sourceIdentity.MatchString(input.CheckpointID) || input.WriterEpoch == 0 || input.WriterEpoch < service.ownerEpoch {
			sourceError(response, http.StatusConflict, "Source checkpoint writer changed")
			return
		}
		if operation == "checkpoint" {
			if service.checkpointID != "" && (service.checkpointID != input.CheckpointID || service.ownerEpoch != input.WriterEpoch) {
				sourceError(response, 409, "Source checkpoint identity changed")
				return
			}
			// Storage-owner transfer and Change human/Agent authority are distinct
			// existing leases. A checkpoint must not replace the Change fence.
			service.ownerEpoch, service.writable = input.WriterEpoch, false
			service.checkpointID = input.CheckpointID
			if service.checkpointFile == nil {
				file, err := os.CreateTemp("", "factory-source-bundle-*")
				if err != nil {
					response.Header().Set("X-Factory-Source-Checkpoint-Failure", checkpointFailureReason(err))
					service.error(response, err)
					return
				}
				bundle, err := service.source.ExportBundle(file)
				if err != nil {
					file.Close()
					os.Remove(file.Name())
					response.Header().Set("X-Factory-Source-Checkpoint-Failure", checkpointFailureReason(err))
					service.error(response, err)
					return
				}
				service.checkpointID, service.checkpointFile, service.checkpointBundle = input.CheckpointID, file, bundle
			}
			response.Header().Set("Content-Type", "application/json")
			json.NewEncoder(response).Encode(service.checkpointBundle)
			return
		}
		if service.checkpointID != input.CheckpointID || service.writable || input.WriterEpoch != service.ownerEpoch || input.Chunk < 0 || input.Chunk >= len(service.checkpointBundle.Chunks) {
			sourceError(response, 409, "Source checkpoint is unconfirmed")
			return
		}
		response.Header().Set("Content-Type", "application/octet-stream")
		size := min(int64(SourceChunkBytes), service.checkpointBundle.Bytes-int64(input.Chunk)*SourceChunkBytes)
		io.CopyN(response, io.NewSectionReader(service.checkpointFile, int64(input.Chunk)*SourceChunkBytes, size), size)
		return
	}
	mutation := operation == "write" || operation == "mkdir" || operation == "rename" || operation == "delete"
	if mutation || operation == "fence" {
		// Decode first. A timed-out upload cannot queue behind a fence then run
		// with its previous writing authority. The epoch is checked under the
		// same lock held until the filesystem operation has finished.
		service.writes.Lock()
		defer service.writes.Unlock()
		if operation == "fence" {
			if service.checkpointID != "" && input.Writable {
				sourceError(response, http.StatusConflict, "Source owner is frozen for checkpoint")
				return
			}
			if input.WriterEpoch == 0 || input.WriterEpoch < service.writerEpoch ||
				(input.WriterEpoch == service.writerEpoch && input.Writable != service.writable) {
				sourceError(response, http.StatusConflict, "Source writer changed")
				return
			}
			service.writerEpoch, service.writable = input.WriterEpoch, input.Writable
			response.Header().Set("Content-Type", "application/json")
			json.NewEncoder(response).Encode(map[string]bool{"confirmed": true})
			return
		}
		if service.writerEpoch != 0 || request.Header.Get("X-Factory-Writer-Epoch") != "" {
			epoch, err := strconv.ParseUint(request.Header.Get("X-Factory-Writer-Epoch"), 10, 64)
			if err != nil || epoch != service.writerEpoch || !service.writable {
				sourceError(response, http.StatusConflict, "Source writer changed; keep your editor buffer")
				return
			}
		}
	}
	var value any
	var err error
	switch operation {
	case "stat":
		value, err = service.source.Stat(input.Path)
	case "list":
		value, err = service.source.List(input.Path)
	case "read":
		value, err = service.source.Read(input.Path)
	case "write":
		value, err = service.source.Write(input.Path, input.Content, input.Version)
	case "mkdir":
		err = service.source.Mkdir(input.Path)
	case "rename":
		err = service.source.Rename(input.Path, input.Destination, input.Overwrite)
	case "delete":
		err = service.source.Delete(input.Path, input.Recursive)
	case "search":
		if input.Search == nil || input.Path != "" {
			sourceError(response, http.StatusBadRequest, "Invalid source search")
			return
		}
		value, err = service.source.Search(request.Context(), *input.Search)
	default:
		sourceError(response, http.StatusNotFound, "Source operation is unavailable")
		return
	}
	if err != nil {
		service.error(response, err)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	json.NewEncoder(response).Encode(value)
}

func sourceError(response http.ResponseWriter, status int, message string) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	json.NewEncoder(response).Encode(map[string]string{"error": message})
}

// Internal checkpoint diagnostics contain only fixed categories or errno. Never
// forward filesystem errors containing private paths, Source bytes or tokens.
func checkpointFailureReason(err error) string {
	switch {
	case errors.Is(err, ErrPath):
		return "path-boundary"
	case errors.Is(err, ErrConflict):
		return "conflicting-writer"
	case errors.Is(err, ErrTooLarge):
		return "size-limit"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return "io-" + strconv.Itoa(int(errno))
	}
	switch err.Error() {
	case "unsupported Source ownership or mode":
		return "ownership-mode"
	case "unsupported Source entry", "unsupported Source entry type":
		return "entry-type"
	case "external Git directory is unsupported":
		return "external-git"
	case "Source xattrs could not be enumerated":
		return "xattr-enumeration"
	case "unsupported Source xattr namespace":
		return "xattr-namespace"
	case "Source xattr is unavailable":
		return "xattr-value"
	case "Source hardlink leaves the checkout":
		return "external-hardlink"
	default:
		return "unconfirmed"
	}
}

func (service *Service) error(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrConflict):
		sourceError(response, http.StatusConflict, ErrConflict.Error())
	case errors.Is(err, ErrTooLarge):
		sourceError(response, http.StatusRequestEntityTooLarge, ErrTooLarge.Error())
	case errors.Is(err, unix.ENOENT):
		sourceError(response, http.StatusNotFound, "Source entry was not found")
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM), errors.Is(err, unix.ELOOP), errors.Is(err, unix.EXDEV), errors.Is(err, ErrPath):
		sourceError(response, http.StatusForbidden, ErrPath.Error())
	default:
		sourceError(response, http.StatusServiceUnavailable, "Source operation is unavailable")
	}
}

func (service *Service) events(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	stop := context.AfterFunc(service.ctx, cancel)
	defer stop()
	stream, err := service.source.Watch(ctx)
	if err != nil {
		service.error(response, err)
		return
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		sourceError(response, http.StatusServiceUnavailable, "Source events are unavailable")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.WriteHeader(http.StatusOK)
	io.WriteString(response, "data: {\"kind\":\"resync\",\"path\":\"\"}\n\n")
	flusher.Flush()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(response, ": source\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case change, open := <-stream:
			if !open {
				return
			}
			encoded, err := json.Marshal(change)
			if err != nil {
				return
			}
			if _, err := response.Write(append(append([]byte("data: "), encoded...), '\n', '\n')); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
