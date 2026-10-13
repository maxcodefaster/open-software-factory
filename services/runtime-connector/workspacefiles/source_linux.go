// Package workspacefiles provides source access without starting an execution runtime.
package workspacefiles

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const MaxFileBytes = 2 << 20
const maxDirectoryEntries = 10_000
const savePrefix = ".factory-save-"

var (
	ErrPath     = errors.New("source path is not accessible")
	ErrConflict = errors.New("source changed; keep the editor buffer and reload or resolve the conflict")
	ErrTooLarge = errors.New("source operation exceeds its size limit")
)

type Metadata struct {
	Name  string `json:"name,omitempty"`
	Kind  string `json:"kind"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Ctime int64  `json:"ctime"`
}

type File struct {
	Metadata
	Content []byte `json:"content"`
	Version string `json:"version"`
}

type Source struct {
	root     *os.File
	life     sync.RWMutex
	writes   sync.Mutex
	closed   chan struct{}
	watchers sync.WaitGroup
}

func Open(checkout string) (*Source, error) {
	fd, err := unix.Open(checkout, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	return &Source{root: os.NewFile(uintptr(fd), checkout), closed: make(chan struct{})}, nil
}

func (source *Source) Close() error {
	source.life.Lock()
	if source.root == nil {
		source.life.Unlock()
		source.watchers.Wait()
		return nil
	}
	close(source.closed)
	err := source.root.Close()
	source.root = nil
	source.life.Unlock()
	source.watchers.Wait()
	return err
}

func validPath(name string) bool {
	if len(name) > 4096 || strings.ContainsAny(name, "\x00\\") || strings.HasPrefix(name, "/") {
		return false
	}
	if name == "" {
		return true
	}
	if path.Clean(name) != name || name == "." || name == ".." || strings.HasPrefix(name, "../") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".git" || strings.HasPrefix(part, savePrefix) {
			return false
		}
	}
	return true
}

// The kernel resolves every component beneath the pinned checkout directory.
// No symlink, magic link or nested mount is followed, including during rename races.
func (source *Source) descriptor(name string) (*os.File, unix.Stat_t, error) {
	if source.root == nil {
		return nil, unix.Stat_t{}, os.ErrClosed
	}
	if !validPath(name) {
		return nil, unix.Stat_t{}, ErrPath
	}
	if name == "" {
		name = "."
	}
	fd, err := unix.Openat2(int(source.root.Fd()), name, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return nil, unix.Stat_t{}, err
	}
	file := os.NewFile(uintptr(fd), name)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		file.Close()
		return nil, stat, err
	}
	kind := stat.Mode & unix.S_IFMT
	if kind != unix.S_IFDIR && (kind != unix.S_IFREG || stat.Nlink != 1) {
		file.Close()
		return nil, stat, ErrPath
	}
	return file, stat, nil
}

func metadata(stat unix.Stat_t) Metadata {
	kind := "file"
	if stat.Mode&unix.S_IFMT == unix.S_IFDIR {
		kind = "directory"
	}
	return Metadata{Kind: kind, Size: stat.Size, Mtime: stat.Mtim.Nano() / 1e6, Ctime: stat.Ctim.Nano() / 1e6}
}

func reopen(file *os.File, flags int) (*os.File, error) {
	fd, err := unix.Open(fmt.Sprintf("/proc/self/fd/%d", file.Fd()), flags|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), file.Name()), nil
}

func (source *Source) Stat(name string) (Metadata, error) {
	source.life.RLock()
	defer source.life.RUnlock()
	file, stat, err := source.descriptor(name)
	if err != nil {
		return Metadata{}, err
	}
	defer file.Close()
	return metadata(stat), nil
}

func (source *Source) Read(name string) (File, error) {
	source.life.RLock()
	defer source.life.RUnlock()
	return source.read(name)
}

func (source *Source) read(name string) (File, error) {
	file, stat, err := source.descriptor(name)
	if err != nil {
		return File{}, err
	}
	defer file.Close()
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return File{}, unix.EISDIR
	}
	if stat.Size > MaxFileBytes {
		return File{}, ErrTooLarge
	}
	reader, err := reopen(file, unix.O_RDONLY)
	if err != nil {
		return File{}, err
	}
	defer reader.Close()
	before := stat
	content, err := io.ReadAll(io.LimitReader(reader, MaxFileBytes+1))
	if err != nil {
		return File{}, err
	}
	if len(content) > MaxFileBytes {
		return File{}, ErrTooLarge
	}
	if err := unix.Fstat(int(reader.Fd()), &stat); err != nil {
		return File{}, err
	}
	if before.Size != stat.Size || before.Mtim != stat.Mtim || before.Ctim != stat.Ctim || stat.Size != int64(len(content)) || stat.Nlink != 1 {
		return File{}, ErrConflict
	}
	digest := sha256.Sum256(content)
	return File{Metadata: metadata(stat), Content: content, Version: hex.EncodeToString(digest[:])}, nil
}

func (source *Source) List(name string) ([]Metadata, error) {
	source.life.RLock()
	defer source.life.RUnlock()
	file, stat, err := source.descriptor(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return nil, unix.ENOTDIR
	}
	directory, err := reopen(file, unix.O_RDONLY|unix.O_DIRECTORY)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	entries, err := directory.ReadDir(maxDirectoryEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > maxDirectoryEntries {
		return nil, ErrTooLarge
	}
	result := make([]Metadata, 0, len(entries))
	for _, entry := range entries {
		child, childStat, err := source.descriptor(path.Join(name, entry.Name()))
		if err != nil {
			continue // Protected metadata, links and concurrently removed entries are not source.
		}
		child.Close()
		item := metadata(childStat)
		item.Name = entry.Name()
		result = append(result, item)
	}
	return result, nil
}

// An empty observed version creates only. Existing files require the version read
// by that editor. This serializes service writers, not arbitrary runtime shell writes.
func (source *Source) Write(name string, content []byte, observed string) (File, error) {
	source.life.RLock()
	defer source.life.RUnlock()
	source.writes.Lock()
	defer source.writes.Unlock()
	if len(content) > MaxFileBytes {
		return File{}, ErrTooLarge
	}
	if name == "" || !validPath(name) {
		return File{}, ErrPath
	}
	parent := path.Dir(name)
	if parent == "." {
		parent = ""
	}
	directory, _, err := source.descriptor(parent)
	if err != nil {
		return File{}, err
	}
	defer directory.Close()
	mode := uint32(0644)
	current, err := source.read(name)
	if err == nil {
		requested := sha256.Sum256(content)
		if current.Version == hex.EncodeToString(requested[:]) {
			return current, nil // An identical save can recover a lost acknowledgement without another write.
		}
		if observed == "" || current.Version != observed {
			return File{}, ErrConflict
		}
		existing, stat, err := source.descriptor(name)
		if err != nil {
			return File{}, err
		}
		existing.Close()
		mode = stat.Mode & 0777
	} else if !errors.Is(err, unix.ENOENT) {
		return File{}, err
	} else if observed != "" {
		return File{}, ErrConflict
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return File{}, err
	}
	temporary := savePrefix + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(directory.Fd()), temporary, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return File{}, err
	}
	defer unix.Unlinkat(int(directory.Fd()), temporary, 0)
	output := os.NewFile(uintptr(fd), temporary)
	defer output.Close()
	if _, err := output.Write(content); err != nil {
		return File{}, err
	}
	if err := unix.Fchmod(fd, mode); err != nil {
		return File{}, err
	}
	if err := output.Sync(); err != nil {
		return File{}, err
	}
	// Catch known runtime edits during preparation. There remains a shell-write
	// race after this check; writer coordination is a separate lifecycle requirement.
	latest, err := source.read(name)
	if observed == "" {
		if err == nil {
			return File{}, ErrConflict
		}
		if !errors.Is(err, unix.ENOENT) {
			return File{}, err
		}
	} else if err != nil || latest.Version != observed {
		return File{}, ErrConflict
	}
	flags := uint(0)
	if observed == "" {
		flags = unix.RENAME_NOREPLACE
	}
	if err := unix.Renameat2(int(directory.Fd()), temporary, int(directory.Fd()), path.Base(name), flags); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return File{}, ErrConflict
		}
		return File{}, err
	}
	committedDirectory, err := reopen(directory, unix.O_RDONLY|unix.O_DIRECTORY)
	if err != nil {
		return File{}, err
	}
	defer committedDirectory.Close()
	if err := committedDirectory.Sync(); err != nil {
		return File{}, err
	}
	return source.read(name)
}
