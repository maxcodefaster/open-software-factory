package workspacefiles

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"golang.org/x/sys/unix"
)

const maxWatchDirectories = 2048
const watchQueue = 64
const watchMask = unix.IN_CREATE | unix.IN_MODIFY | unix.IN_CLOSE_WRITE | unix.IN_DELETE |
	unix.IN_MOVED_FROM | unix.IN_MOVED_TO | unix.IN_MOVE_SELF | unix.IN_DELETE_SELF

type Change struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type sourceWatch struct {
	source      *Source
	fd          int
	directories map[int]string
	changes     chan Change
}

// Watch observes the canonical source locally. It never scans file contents or
// polls repositories. Overflow and directory topology changes request reconciliation.
func (source *Source) Watch(ctx context.Context) (<-chan Change, error) {
	source.life.RLock()
	if source.root == nil {
		source.life.RUnlock()
		return nil, os.ErrClosed
	}
	source.watchers.Add(1)
	source.life.RUnlock()
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		source.watchers.Done()
		return nil, err
	}
	watch := &sourceWatch{source: source, fd: fd, directories: make(map[int]string), changes: make(chan Change, watchQueue)}
	if err := watch.addTree(ctx, ""); err != nil {
		unix.Close(fd)
		source.watchers.Done()
		return nil, err
	}
	go watch.run(ctx)
	return watch.changes, nil
}

func excludedWatchPath(name string) bool {
	if !validPath(name) {
		return true
	}
	for _, part := range strings.Split(name, "/") {
		if part == "node_modules" {
			return true
		}
	}
	return false
}

func (watch *sourceWatch) addTree(ctx context.Context, name string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	watch.source.life.RLock()
	file, stat, err := watch.source.descriptor(name)
	if err != nil {
		watch.source.life.RUnlock()
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		file.Close()
		watch.source.life.RUnlock()
		return unix.ENOTDIR
	}
	if len(watch.directories) >= maxWatchDirectories {
		file.Close()
		watch.source.life.RUnlock()
		return ErrTooLarge
	}
	wd, err := unix.InotifyAddWatch(watch.fd, fmt.Sprintf("/proc/self/fd/%d", file.Fd()), watchMask)
	file.Close()
	watch.source.life.RUnlock()
	if err != nil {
		return err
	}
	watch.directories[wd] = name
	entries, err := watch.source.List(name)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		child := path.Join(name, entry.Name)
		if entry.Kind != "directory" || excludedWatchPath(child) {
			continue
		}
		if err := watch.addTree(ctx, child); err != nil && !errors.Is(err, unix.ENOENT) {
			return err
		}
	}
	return nil
}

func (watch *sourceWatch) emit(change Change) {
	select {
	case watch.changes <- change:
	default:
		// A slow reader gets one explicit resync, not an unbounded backlog or
		// an apparently complete stream with silently dropped changes.
		for len(watch.changes) > 0 {
			select {
			case <-watch.changes:
			default:
			}
		}
		watch.changes <- Change{Kind: "resync"}
	}
}

func (watch *sourceWatch) reconcile(ctx context.Context) error {
	for wd := range watch.directories {
		unix.InotifyRmWatch(watch.fd, uint32(wd))
	}
	clear(watch.directories)
	if err := watch.addTree(ctx, ""); err != nil {
		return err
	}
	watch.emit(Change{Kind: "resync"})
	return nil
}

func (watch *sourceWatch) run(ctx context.Context) {
	defer watch.source.watchers.Done()
	defer close(watch.changes)
	defer unix.Close(watch.fd)
	buffer := make([]byte, 64<<10)
	for {
		select {
		case <-ctx.Done():
			return
		case <-watch.source.closed:
			return
		default:
		}
		_, err := unix.Poll([]unix.PollFd{{Fd: int32(watch.fd), Events: unix.POLLIN}}, 100)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			watch.emit(Change{Kind: "resync"})
			return
		}
		count, err := unix.Read(watch.fd, buffer)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			watch.emit(Change{Kind: "resync"})
			return
		}
		for offset := 0; offset+unix.SizeofInotifyEvent <= count; {
			wd := int(int32(binary.NativeEndian.Uint32(buffer[offset:])))
			mask := binary.NativeEndian.Uint32(buffer[offset+4:])
			length := int(binary.NativeEndian.Uint32(buffer[offset+12:]))
			end := offset + unix.SizeofInotifyEvent + length
			if end > count {
				watch.emit(Change{Kind: "resync"})
				return
			}
			name := strings.TrimRight(string(buffer[offset+unix.SizeofInotifyEvent:end]), "\x00")
			offset = end
			if mask&unix.IN_Q_OVERFLOW != 0 {
				if watch.reconcile(ctx) != nil {
					watch.emit(Change{Kind: "resync"})
					return
				}
				continue
			}
			directory, known := watch.directories[wd]
			if !known || mask&unix.IN_IGNORED != 0 {
				continue
			}
			resource := path.Join(directory, name)
			if resource == "." {
				resource = ""
			}
			if excludedWatchPath(resource) {
				continue
			}
			kind := "updated"
			if mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0 {
				kind = "added"
			} else if mask&(unix.IN_DELETE|unix.IN_MOVED_FROM) != 0 {
				kind = "deleted"
			}
			if mask&unix.IN_ISDIR != 0 || mask&(unix.IN_MOVE_SELF|unix.IN_DELETE_SELF) != 0 {
				if watch.reconcile(ctx) != nil {
					watch.emit(Change{Kind: "resync"})
					return
				}
			}
			watch.emit(Change{Path: resource, Kind: kind})
		}
	}
}
