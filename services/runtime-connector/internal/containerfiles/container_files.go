package containerfiles

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
	"unicode/utf8"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
)

const maxContainerTransfer = 128 << 20
const maxContainerChunk = 256 << 10

type Request struct {
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

type View struct {
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

type Listing struct {
	Entries    []View `json:"entries"`
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

type Manager struct {
	root      *os.Root
	mutex     sync.Mutex
	transfers map[string]*containerTransfer
}

func NewManager(root string) (*Manager, error) {
	directory, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	return &Manager{root: directory, transfers: make(map[string]*containerTransfer)}, nil
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

func (manager *Manager) open(path string) (*os.File, os.FileInfo, error) {
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

func (manager *Manager) Read(input Request) (View, error) {
	file, info, err := manager.open(input.Path)
	if err != nil {
		return View{}, err
	}
	defer file.Close()
	version, err := containerFileVersion(file, info)
	if err != nil {
		return View{}, err
	}
	if input.Version != "" && input.Version != version {
		return View{}, errors.New("container file version changed")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = 16384
	}
	if input.Offset < 0 || input.Offset > maxContainerTransfer || limit > maxContainerChunk {
		return View{}, errors.New("invalid container file window")
	}
	end := min(info.Size(), input.Offset+limit)
	if input.Offset > end {
		return View{}, errors.New("container file offset exceeds size")
	}
	// Match workspace-domain's utf8TextPage rule: return complete characters
	// inside the byte budget. At most three lookahead bytes validate a split
	// tail without returning it or buffering the whole file.
	readEnd := min(info.Size(), end+utf8.UTFMax-1)
	content := make([]byte, readEnd-input.Offset)
	count, err := file.ReadAt(content, input.Offset)
	if err != nil && err != io.EOF {
		return View{}, err
	}
	if after, err := file.Stat(); count != len(content) || err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return View{}, errors.New("container file changed during read")
	}
	if input.Offset > 0 && len(content) > 0 && !utf8.RuneStart(content[0]) {
		return View{}, errors.New("UTF-8 text page offset must be a character boundary")
	}
	var pageBytes int64
	for pageBytes < end-input.Offset {
		character, width := utf8.DecodeRune(content[pageBytes:])
		if character == utf8.RuneError && width == 1 {
			return View{}, errors.New("UTF-8 text page contains invalid encoding; use a binary file transfer")
		}
		if pageBytes+int64(width) > end-input.Offset {
			break
		}
		pageBytes += int64(width)
	}
	if pageBytes == 0 && len(content) > 0 {
		return View{}, errors.New("UTF-8 text page limit cannot fit the next character; increase limit")
	}
	content = content[:pageBytes]
	end = input.Offset + pageBytes
	return View{Path: input.Path, Version: version, Bytes: info.Size(), Content: content, Offset: input.Offset, NextOffset: end, Complete: end == info.Size()}, nil
}

func (manager *Manager) Stat(input Request) (View, error) {
	file, info, err := manager.open(input.Path)
	if err != nil {
		return View{}, err
	}
	defer file.Close()
	view := View{Path: input.Path, Bytes: info.Size(), Directory: info.IsDir()}
	if !info.IsDir() {
		view.Version, err = containerFileVersion(file, info)
	}
	return view, err
}

func (manager *Manager) List(input Request) (Listing, error) {
	file, info, err := manager.open(input.Path)
	if err != nil {
		return Listing{}, err
	}
	defer file.Close()
	if !info.IsDir() {
		return Listing{}, errors.New("container listing needs a directory")
	}
	entries, err := file.ReadDir(10001)
	if err != nil && err != io.EOF {
		return Listing{}, err
	}
	if len(entries) > 10000 {
		return Listing{}, errors.New("container directory listing exceeds its bound")
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	if input.Offset < 0 {
		return Listing{}, errors.New("invalid listing offset")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		return Listing{}, errors.New("container listing page is too large")
	}
	start := min(int64(len(entries)), input.Offset)
	end := min(int64(len(entries)), start+limit)
	views := make([]View, 0, end-start)
	for _, entry := range entries[start:end] {
		info, err := entry.Info()
		if err != nil || (!info.IsDir() && !info.Mode().IsRegular()) {
			continue
		}
		views = append(views, View{Path: filepath.Join(input.Path, entry.Name()), Bytes: info.Size(), Directory: info.IsDir()})
	}
	listing := Listing{Entries: views}
	if end < int64(len(entries)) {
		listing.NextOffset = &end
	}
	return listing, nil
}

func (manager *Manager) Mutate(action string, input Request) (View, error) {
	path, err := containerPath(input.Path)
	if err != nil || path == "." {
		return View{}, errors.New("container mutation needs a non-root path")
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	parent, err := manager.openDirectory(filepath.Dir(path))
	if err != nil {
		return View{}, err
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
			return View{}, errors.New("invalid container rename destination")
		}
		if !input.Overwrite {
			err = manager.renameExclusive(path, destination)
		} else {
			parent, openErr := manager.openDirectory(filepath.Dir(destination))
			if openErr != nil {
				return View{}, openErr
			}
			parent.Close()
			err = manager.root.Rename(path, destination)
		}
	default:
		return View{}, errors.New("unsupported container mutation")
	}
	if err != nil {
		return View{}, err
	}
	return View{Path: input.Path, Complete: true}, nil
}

func (manager *Manager) BeginUpload(input Request) (View, error) {
	if !procutil.CommandIDPattern.MatchString(input.ID) || input.Bytes < 0 || input.Bytes > maxContainerTransfer || len(input.SHA256) != 64 {
		return View{}, errors.New("invalid upload identity or size")
	}
	if _, err := hex.DecodeString(input.SHA256); err != nil {
		return View{}, errors.New("invalid upload digest")
	}
	path, err := containerPath(input.Path)
	if err != nil || path == "." {
		return View{}, errors.New("invalid upload destination")
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if previous := manager.transfers[input.ID]; previous != nil {
		if !previous.upload || previous.path != path || previous.bytes != input.Bytes || previous.version != input.SHA256 || previous.expected != input.Version {
			return View{}, errors.New("transfer identity has different input")
		}
		return manager.transferView(previous), nil
	}
	if len(manager.transfers) >= 8 {
		return View{}, errors.New("active file transfer limit reached")
	}
	mode := os.FileMode(0644)
	if existing, info, err := manager.open(input.Path); err == nil {
		version, hashErr := containerFileVersion(existing, info)
		existing.Close()
		if hashErr != nil || input.Version == "" || version != input.Version {
			return View{}, errors.New("upload destination version changed")
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) || input.Version != "" {
		return View{}, errors.New("upload destination is unavailable")
	}
	parent, err := manager.root.Open(filepath.Dir(path))
	if err != nil {
		return View{}, err
	}
	allowed := allowedContainerFilesystem(parent)
	parent.Close()
	if !allowed {
		return View{}, errors.New("upload destination filesystem is unavailable")
	}
	temporary := filepath.Join(filepath.Dir(path), ".factory-upload-"+input.ID)
	file, err := manager.root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return View{}, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return View{}, err
	}
	transfer := &containerTransfer{id: input.ID, path: path, file: file, temporary: temporary, bytes: input.Bytes, version: input.SHA256, expected: input.Version, mode: mode, upload: true, before: info, expires: time.Now().Add(30 * time.Minute)}
	manager.transfers[input.ID] = transfer
	return manager.transferView(transfer), nil
}

func (manager *Manager) transferView(transfer *containerTransfer) View {
	return View{ID: transfer.id, Path: "/" + transfer.path, Version: transfer.version, Bytes: transfer.bytes, NextOffset: transfer.written, Complete: transfer.complete}
}

func (manager *Manager) Upload(input Request) (View, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil || !transfer.upload || transfer.complete || input.Offset < 0 || input.Offset > transfer.bytes || len(input.Content) > maxContainerChunk || input.Offset+int64(len(input.Content)) > transfer.bytes {
		return View{}, errors.New("upload chunk is unavailable")
	}
	if input.Offset < transfer.written {
		if input.Offset+int64(len(input.Content)) > transfer.written {
			return View{}, errors.New("upload chunk overlaps unconfirmed bytes")
		}
		before := make([]byte, len(input.Content))
		if _, err := transfer.file.ReadAt(before, input.Offset); err != nil || string(before) != string(input.Content) {
			return View{}, errors.New("repeated upload chunk has different bytes")
		}
		return manager.transferView(transfer), nil
	}
	if input.Offset != transfer.written {
		return View{}, errors.New("upload offset is not sequential")
	}
	count, err := transfer.file.WriteAt(input.Content, input.Offset)
	if err != nil {
		return View{}, err
	}
	transfer.written += int64(count)
	return manager.transferView(transfer), nil
}

func (manager *Manager) CommitUpload(input Request) (View, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil || !transfer.upload {
		return View{}, errors.New("upload is unavailable")
	}
	if transfer.complete {
		return manager.transferView(transfer), nil
	}
	if transfer.written != transfer.bytes {
		return View{}, errors.New("upload bytes are incomplete")
	}
	info, err := transfer.file.Stat()
	if err != nil {
		return View{}, err
	}
	version, err := containerFileVersion(transfer.file, info)
	if err != nil || version != transfer.version {
		return View{}, errors.New("upload checksum does not match")
	}
	if file, info, err := manager.open("/" + transfer.path); err == nil {
		current, hashErr := containerFileVersion(file, info)
		file.Close()
		if hashErr != nil || current != transfer.expected {
			return View{}, errors.New("upload destination changed before commit")
		}
	} else if !errors.Is(err, os.ErrNotExist) || transfer.expected != "" {
		return View{}, errors.New("upload destination is unavailable")
	}
	if err := transfer.file.Chmod(transfer.mode); err != nil {
		return View{}, err
	}
	if err := transfer.file.Sync(); err != nil {
		return View{}, err
	}
	pathInfo, err := manager.root.Lstat(transfer.temporary)
	if err != nil || !os.SameFile(info, pathInfo) {
		return View{}, errors.New("upload temporary identity changed")
	}
	if transfer.expected == "" {
		err = manager.renameExclusive(transfer.temporary, transfer.path)
	} else {
		err = manager.root.Rename(transfer.temporary, transfer.path)
	}
	if err != nil {
		return View{}, err
	}
	transfer.complete = true
	return manager.transferView(transfer), nil
}

func (manager *Manager) BeginDownload(input Request) (View, error) {
	if !procutil.CommandIDPattern.MatchString(input.ID) {
		return View{}, errors.New("invalid download identity")
	}
	path, err := containerPath(input.Path)
	if err != nil {
		return View{}, err
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if previous := manager.transfers[input.ID]; previous != nil {
		if previous.upload || previous.path != path || previous.expected != input.Version {
			return View{}, errors.New("transfer identity has different input")
		}
		return manager.transferView(previous), nil
	}
	if len(manager.transfers) >= 8 {
		return View{}, errors.New("active file transfer limit reached")
	}
	file, info, err := manager.open(input.Path)
	if err != nil {
		return View{}, err
	}
	version, err := containerFileVersion(file, info)
	if err != nil {
		file.Close()
		return View{}, err
	}
	if input.Version != "" && input.Version != version {
		file.Close()
		return View{}, errors.New("download file version changed")
	}
	transfer := &containerTransfer{id: input.ID, path: path, file: file, bytes: info.Size(), version: version, expected: input.Version, before: info, expires: time.Now().Add(30 * time.Minute)}
	manager.transfers[input.ID] = transfer
	return manager.transferView(transfer), nil
}

func (manager *Manager) Download(input Request) (View, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil || transfer.upload || input.Offset < 0 || input.Offset > transfer.bytes {
		return View{}, errors.New("download is unavailable")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = maxContainerChunk
	}
	if limit > maxContainerChunk {
		return View{}, errors.New("download chunk exceeds its bound")
	}
	info, err := transfer.file.Stat()
	if err != nil || info.Size() != transfer.before.Size() || !info.ModTime().Equal(transfer.before.ModTime()) {
		return View{}, errors.New("download file changed")
	}
	end := min(transfer.bytes, input.Offset+limit)
	content := make([]byte, end-input.Offset)
	if _, err := transfer.file.ReadAt(content, input.Offset); err != nil && err != io.EOF {
		return View{}, err
	}
	if after, err := transfer.file.Stat(); err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return View{}, errors.New("download file changed during read")
	}
	view := manager.transferView(transfer)
	view.Offset, view.NextOffset, view.Content = input.Offset, end, content
	view.Complete = end == transfer.bytes
	return view, nil
}

func (manager *Manager) Status(input Request) (View, error) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	transfer := manager.transfers[input.ID]
	if transfer == nil {
		return View{}, errors.New("transfer handle is unavailable; do not recreate it")
	}
	return manager.transferView(transfer), nil
}

func (manager *Manager) openDirectory(path string) (*os.File, error) {
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

func (manager *Manager) Sweep() {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	for id, transfer := range manager.transfers {
		if !transfer.expires.IsZero() && time.Now().After(transfer.expires) {
			manager.releaseLocked(id)
		}
	}
}

func (manager *Manager) Release(input Request) error {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	manager.releaseLocked(input.ID)
	return nil
}

func (manager *Manager) releaseLocked(id string) {
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

func (manager *Manager) Close() {
	manager.mutex.Lock()
	ids := make([]string, 0, len(manager.transfers))
	for id := range manager.transfers {
		ids = append(ids, id)
	}
	manager.mutex.Unlock()
	for _, id := range ids {
		_ = manager.Release(Request{ID: id})
	}
	manager.root.Close()
}
