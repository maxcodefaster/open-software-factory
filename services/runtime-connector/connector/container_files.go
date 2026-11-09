package connector

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxContainerTransfer = 128 << 20
const maxContainerChunk = 256 << 10

type ContainerFileRequest struct {
	ID          string `json:"id,omitempty"`
	Path        string `json:"path,omitempty"`
	Version     string `json:"version,omitempty"`
	Offset      int64  `json:"offset,omitempty"`
	Limit       int64  `json:"limit,omitempty"`
	Content     []byte `json:"content,omitempty"`
	Destination string `json:"destination,omitempty"`
	Recursive   bool   `json:"recursive,omitempty"`
	Overwrite   bool   `json:"overwrite,omitempty"`
	Bytes       int64  `json:"bytes,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
}

type ContainerFileView struct {
	ID         string `json:"id,omitempty"`
	Path       string `json:"path,omitempty"`
	Version    string `json:"version,omitempty"`
	Bytes      int64  `json:"bytes"`
	Directory  bool   `json:"directory,omitempty"`
	Content    []byte `json:"content,omitempty"`
	Offset     int64  `json:"offset,omitempty"`
	NextOffset int64  `json:"nextOffset,omitempty"`
	Complete   bool   `json:"complete,omitempty"`
}

type ContainerFileListing struct {
	Entries    []ContainerFileView `json:"entries"`
	NextOffset *int64              `json:"nextOffset"`
}

type containerTransfer struct {
	id        string
	path      string
	file      *os.File
	temporary string
	bytes     int64
	written   int64
	version   string
	expected  string
	mode      os.FileMode
	upload    bool
	complete  bool
	before    os.FileInfo
	expires   time.Time
}

type containerFileManager struct {
	root      *os.Root
	mutex     sync.Mutex
	transfers map[string]*containerTransfer
}

func newContainerFileManager(root string) (*containerFileManager, error) {
	directory, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	return &containerFileManager{root: directory, transfers: make(map[string]*containerTransfer)}, nil
}

func containerPath(value string) (string, error) {
	if !filepath.IsAbs(value) || len(value) > 4096 || strings.ContainsRune(value, 0) {
		return "", errors.New("container path must be absolute")
	}
	for _, component := range strings.Split(value, "/") {
		if component == ".." {
			return "", errors.New("container path traversal is not allowed")
		}
	}
	clean := strings.TrimPrefix(filepath.Clean(value), "/")
	for _, denied := range []string{"proc", "sys", "dev"} {
		if clean == denied || strings.HasPrefix(clean, denied+"/") {
			return "", errors.New("special container files are unavailable")
		}
	}
	if clean == "" {
		clean = "."
	}
	return clean, nil
}

func (manager *containerFileManager) open(path string) (*os.File, os.FileInfo, error) {
	name, err := containerPath(path)
	if err != nil {
		return nil, nil, err
	}
	file, err := manager.root.OpenFile(name, os.O_RDONLY|containerNonblocking, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || (!info.Mode().IsRegular() && !info.IsDir()) || !allowedContainerFilesystem(file) {
		file.Close()
		return nil, nil, errors.New("container file is not an ordinary accessible entry")
	}
	return file, info, nil
}

func containerFileVersion(file *os.File, before os.FileInfo) (string, error) {
	if !before.Mode().IsRegular() || before.Size() > maxContainerTransfer {
		return "", errors.New("container file exceeds the transfer limit")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, io.NewSectionReader(file, 0, before.Size())); err != nil {
		return "", err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return "", errors.New("container file changed during observation")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (manager *containerFileManager) read(input ContainerFileRequest) (ContainerFileView, error) {
	file, info, err := manager.open(input.Path)
	if err != nil {
		return ContainerFileView{}, err
	}
	defer file.Close()
	version, err := containerFileVersion(file, info)
	if err != nil {
		return ContainerFileView{}, err
	}
	if input.Version != "" && input.Version != version {
		return ContainerFileView{}, errors.New("container file version changed")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = 16384
	}
	if input.Offset < 0 || input.Offset > maxContainerTransfer || limit > maxContainerChunk {
		return ContainerFileView{}, errors.New("invalid container file window")
	}
	end := min(info.Size(), input.Offset+limit)
	if input.Offset > end {
		return ContainerFileView{}, errors.New("container file offset exceeds size")
	}
	content := make([]byte, end-input.Offset)
	if _, err := file.ReadAt(content, input.Offset); err != nil && err != io.EOF {
		return ContainerFileView{}, err
	}
	if after, err := file.Stat(); err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return ContainerFileView{}, errors.New("container file changed during read")
	}
	return ContainerFileView{Path: input.Path, Version: version, Bytes: info.Size(), Content: content, Offset: input.Offset, NextOffset: end, Complete: end == info.Size()}, nil
}

func (manager *containerFileManager) stat(input ContainerFileRequest) (ContainerFileView, error) {
	file, info, err := manager.open(input.Path)
	if err != nil {
		return ContainerFileView{}, err
	}
	defer file.Close()
	view := ContainerFileView{Path: input.Path, Bytes: info.Size(), Directory: info.IsDir()}
	if !info.IsDir() {
		view.Version, err = containerFileVersion(file, info)
	}
	return view, err
}

func (manager *containerFileManager) list(input ContainerFileRequest) (ContainerFileListing, error) {
	file, info, err := manager.open(input.Path)
	if err != nil {
		return ContainerFileListing{}, err
	}
	defer file.Close()
	if !info.IsDir() {
		return ContainerFileListing{}, errors.New("container listing needs a directory")
	}
	entries, err := file.ReadDir(10001)
	if err != nil && err != io.EOF {
		return ContainerFileListing{}, err
	}
	if len(entries) > 10000 {
		return ContainerFileListing{}, errors.New("container directory listing exceeds its bound")
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	if input.Offset < 0 {
		return ContainerFileListing{}, errors.New("invalid listing offset")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		return ContainerFileListing{}, errors.New("container listing page is too large")
	}
	start := min(int64(len(entries)), input.Offset)
	end := min(int64(len(entries)), start+limit)
	views := make([]ContainerFileView, 0, end-start)
	for _, entry := range entries[start:end] {
		info, err := entry.Info()
		if err != nil || (!info.IsDir() && !info.Mode().IsRegular()) {
			continue
		}
		views = append(views, ContainerFileView{Path: filepath.Join(input.Path, entry.Name()), Bytes: info.Size(), Directory: info.IsDir()})
	}
	listing := ContainerFileListing{Entries: views}
	if end < int64(len(entries)) {
		listing.NextOffset = &end
	}
	return listing, nil
}

func (manager *containerFileManager) mutate(action string, input ContainerFileRequest) (ContainerFileView, error) {
	path, err := containerPath(input.Path)
	if err != nil || path == "." {
		return ContainerFileView{}, errors.New("container mutation needs a non-root path")
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	parent, err := manager.openDirectory(filepath.Dir(path))
	if err != nil {
		return ContainerFileView{}, err
	}
	parent.Close()
	switch action {
	case "file-mkdir":
		err = manager.root.Mkdir(path, 0755)
	case "file-delete":
		if input.Recursive {
			err = manager.root.RemoveAll(path)
		} else {
			err = manager.root.Remove(path)
		}
	case "file-rename":
		var destination string
		destination, err = containerPath(input.Destination)
		if err != nil || destination == "." {
			return ContainerFileView{}, errors.New("invalid container rename destination")
		}
		if !input.Overwrite {
			err = manager.renameExclusive(path, destination)
		} else {
			parent, openErr := manager.openDirectory(filepath.Dir(destination))
			if openErr != nil {
				return ContainerFileView{}, openErr
			}
			parent.Close()
			err = manager.root.Rename(path, destination)
		}
	default:
		return ContainerFileView{}, errors.New("unsupported container mutation")
	}
	if err != nil {
		return ContainerFileView{}, err
	}
	return ContainerFileView{Path: input.Path, Complete: true}, nil
}

func (manager *containerFileManager) beginUpload(input ContainerFileRequest) (ContainerFileView, error) {
	if !commandIDPattern.MatchString(input.ID) || input.Bytes < 0 || input.Bytes > maxContainerTransfer || len(input.SHA256) != 64 {
		return ContainerFileView{}, errors.New("invalid upload identity or size")
	}
	if _, err := hex.DecodeString(input.SHA256); err != nil {
		return ContainerFileView{}, errors.New("invalid upload digest")
	}
	path, err := containerPath(input.Path)
	if err != nil || path == "." {
		return ContainerFileView{}, errors.New("invalid upload destination")
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if previous := manager.transfers[input.ID]; previous != nil {
		if !previous.upload || previous.path != path || previous.bytes != input.Bytes || previous.version != input.SHA256 || previous.expected != input.Version {
			return ContainerFileView{}, errors.New("transfer identity has different input")
		}
		return manager.transferView(previous), nil
	}
	if len(manager.transfers) >= 8 {
		return ContainerFileView{}, errors.New("active file transfer limit reached")
	}
	mode := os.FileMode(0644)
	if existing, info, err := manager.open(input.Path); err == nil {
		version, hashErr := containerFileVersion(existing, info)
		existing.Close()
		if hashErr != nil || input.Version == "" || version != input.Version {
			return ContainerFileView{}, errors.New("upload destination version changed")
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) || input.Version != "" {
		return ContainerFileView{}, errors.New("upload destination is unavailable")
	}
	parent, err := manager.root.Open(filepath.Dir(path))
	if err != nil {
		return ContainerFileView{}, err
	}
	allowed := allowedContainerFilesystem(parent)
	parent.Close()
	if !allowed {
		return ContainerFileView{}, errors.New("upload destination filesystem is unavailable")
	}
	temporary := filepath.Join(filepath.Dir(path), ".factory-upload-"+input.ID)
	file, err := manager.root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return ContainerFileView{}, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return ContainerFileView{}, err
	}
	transfer := &containerTransfer{id: input.ID, path: path, file: file, temporary: temporary, bytes: input.Bytes, version: input.SHA256, expected: input.Version, mode: mode, upload: true, before: info, expires: time.Now().Add(30 * time.Minute)}
	manager.transfers[input.ID] = transfer
	return manager.transferView(transfer), nil
}

func (manager *containerFileManager) transferView(transfer *containerTransfer) ContainerFileView {
	return ContainerFileView{ID: transfer.id, Path: "/" + transfer.path, Version: transfer.version, Bytes: transfer.bytes, NextOffset: transfer.written, Complete: transfer.complete}
}

func (manager *containerFileManager) upload(input ContainerFileRequest) (ContainerFileView, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil || !transfer.upload || transfer.complete || input.Offset < 0 || input.Offset > transfer.bytes || len(input.Content) > maxContainerChunk || input.Offset+int64(len(input.Content)) > transfer.bytes {
		return ContainerFileView{}, errors.New("upload chunk is unavailable")
	}
	if input.Offset < transfer.written {
		if input.Offset+int64(len(input.Content)) > transfer.written {
			return ContainerFileView{}, errors.New("upload chunk overlaps unconfirmed bytes")
		}
		before := make([]byte, len(input.Content))
		if _, err := transfer.file.ReadAt(before, input.Offset); err != nil || string(before) != string(input.Content) {
			return ContainerFileView{}, errors.New("repeated upload chunk has different bytes")
		}
		return manager.transferView(transfer), nil
	}
	if input.Offset != transfer.written {
		return ContainerFileView{}, errors.New("upload offset is not sequential")
	}
	count, err := transfer.file.WriteAt(input.Content, input.Offset)
	if err != nil {
		return ContainerFileView{}, err
	}
	transfer.written += int64(count)
	return manager.transferView(transfer), nil
}

func (manager *containerFileManager) commitUpload(input ContainerFileRequest) (ContainerFileView, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil || !transfer.upload {
		return ContainerFileView{}, errors.New("upload is unavailable")
	}
	if transfer.complete {
		return manager.transferView(transfer), nil
	}
	if transfer.written != transfer.bytes {
		return ContainerFileView{}, errors.New("upload bytes are incomplete")
	}
	info, err := transfer.file.Stat()
	if err != nil {
		return ContainerFileView{}, err
	}
	version, err := containerFileVersion(transfer.file, info)
	if err != nil || version != transfer.version {
		return ContainerFileView{}, errors.New("upload checksum does not match")
	}
	if file, info, err := manager.open("/" + transfer.path); err == nil {
		current, hashErr := containerFileVersion(file, info)
		file.Close()
		if hashErr != nil || current != transfer.expected {
			return ContainerFileView{}, errors.New("upload destination changed before commit")
		}
	} else if !errors.Is(err, os.ErrNotExist) || transfer.expected != "" {
		return ContainerFileView{}, errors.New("upload destination is unavailable")
	}
	if err := transfer.file.Chmod(transfer.mode); err != nil {
		return ContainerFileView{}, err
	}
	if err := transfer.file.Sync(); err != nil {
		return ContainerFileView{}, err
	}
	pathInfo, err := manager.root.Lstat(transfer.temporary)
	if err != nil || !os.SameFile(info, pathInfo) {
		return ContainerFileView{}, errors.New("upload temporary identity changed")
	}
	if transfer.expected == "" {
		err = manager.renameExclusive(transfer.temporary, transfer.path)
	} else {
		err = manager.root.Rename(transfer.temporary, transfer.path)
	}
	if err != nil {
		return ContainerFileView{}, err
	}
	transfer.complete = true
	return manager.transferView(transfer), nil
}

func (manager *containerFileManager) beginDownload(input ContainerFileRequest) (ContainerFileView, error) {
	if !commandIDPattern.MatchString(input.ID) {
		return ContainerFileView{}, errors.New("invalid download identity")
	}
	path, err := containerPath(input.Path)
	if err != nil {
		return ContainerFileView{}, err
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if previous := manager.transfers[input.ID]; previous != nil {
		if previous.upload || previous.path != path || previous.expected != input.Version {
			return ContainerFileView{}, errors.New("transfer identity has different input")
		}
		return manager.transferView(previous), nil
	}
	if len(manager.transfers) >= 8 {
		return ContainerFileView{}, errors.New("active file transfer limit reached")
	}
	file, info, err := manager.open(input.Path)
	if err != nil {
		return ContainerFileView{}, err
	}
	version, err := containerFileVersion(file, info)
	if err != nil {
		file.Close()
		return ContainerFileView{}, err
	}
	if input.Version != "" && input.Version != version {
		file.Close()
		return ContainerFileView{}, errors.New("download file version changed")
	}
	transfer := &containerTransfer{id: input.ID, path: path, file: file, bytes: info.Size(), version: version, expected: input.Version, before: info, expires: time.Now().Add(30 * time.Minute)}
	manager.transfers[input.ID] = transfer
	return manager.transferView(transfer), nil
}

func (manager *containerFileManager) download(input ContainerFileRequest) (ContainerFileView, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil || transfer.upload || input.Offset < 0 || input.Offset > transfer.bytes {
		return ContainerFileView{}, errors.New("download is unavailable")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = maxContainerChunk
	}
	if limit > maxContainerChunk {
		return ContainerFileView{}, errors.New("download chunk exceeds its bound")
	}
	info, err := transfer.file.Stat()
	if err != nil || info.Size() != transfer.before.Size() || !info.ModTime().Equal(transfer.before.ModTime()) {
		return ContainerFileView{}, errors.New("download file changed")
	}
	end := min(transfer.bytes, input.Offset+limit)
	content := make([]byte, end-input.Offset)
	if _, err := transfer.file.ReadAt(content, input.Offset); err != nil && err != io.EOF {
		return ContainerFileView{}, err
	}
	if after, err := transfer.file.Stat(); err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return ContainerFileView{}, errors.New("download file changed during read")
	}
	view := manager.transferView(transfer)
	view.Offset, view.NextOffset, view.Content = input.Offset, end, content
	view.Complete = end == transfer.bytes
	return view, nil
}

func (manager *containerFileManager) status(input ContainerFileRequest) (ContainerFileView, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil {
		return ContainerFileView{}, errors.New("transfer handle is unavailable; do not recreate it")
	}
	return manager.transferView(transfer), nil
}

func (manager *containerFileManager) openDirectory(path string) (*os.File, error) {
	file, err := manager.root.OpenFile(path, os.O_RDONLY|containerNonblocking, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.IsDir() || !allowedContainerFilesystem(file) {
		file.Close()
		return nil, errors.New("container destination directory is unavailable")
	}
	return file, nil
}

func (manager *containerFileManager) sweep() {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	for id, transfer := range manager.transfers {
		if !transfer.expires.IsZero() && time.Now().After(transfer.expires) {
			manager.releaseLocked(id)
		}
	}
}

func (manager *containerFileManager) release(input ContainerFileRequest) error {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.releaseLocked(input.ID)
	return nil
}

func (manager *containerFileManager) releaseLocked(id string) {
	transfer := manager.transfers[id]
	if transfer == nil {
		return
	}
	if transfer.upload && !transfer.complete {
		if info, err := manager.root.Lstat(transfer.temporary); err == nil && os.SameFile(transfer.before, info) {
			_ = manager.root.Remove(transfer.temporary)
		}
	}
	transfer.file.Close()
	delete(manager.transfers, id)
}

func (manager *containerFileManager) close() {
	manager.mutex.Lock()
	ids := make([]string, 0, len(manager.transfers))
	for id := range manager.transfers {
		ids = append(ids, id)
	}
	manager.mutex.Unlock()
	for _, id := range ids {
		_ = manager.release(ContainerFileRequest{ID: id})
	}
	manager.root.Close()
}
