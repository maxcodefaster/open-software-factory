package workspacefiles

import (
	"errors"
	"io"
	"os"
	"path"

	"golang.org/x/sys/unix"
)

func parentPath(name string) string {
	parent := path.Dir(name)
	if parent == "." {
		return ""
	}
	return parent
}

func syncDirectory(directory *os.File) error {
	writable, err := reopen(directory, unix.O_RDONLY|unix.O_DIRECTORY)
	if err != nil {
		return err
	}
	defer writable.Close()
	return writable.Sync()
}

func (source *Source) Mkdir(name string) error {
	source.life.RLock()
	defer source.life.RUnlock()
	source.writes.Lock()
	defer source.writes.Unlock()
	if name == "" || !validPath(name) {
		return ErrPath
	}
	directory, _, err := source.descriptor(parentPath(name))
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := unix.Mkdirat(int(directory.Fd()), path.Base(name), 0755); err != nil {
		if !errors.Is(err, unix.EEXIST) {
			return err
		}
		existing, stat, err := source.descriptor(name)
		if err != nil {
			return err
		}
		existing.Close()
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
			return ErrConflict
		}
	}
	return syncDirectory(directory)
}

func (source *Source) Rename(name, destination string, overwrite bool) error {
	source.life.RLock()
	defer source.life.RUnlock()
	source.writes.Lock()
	defer source.writes.Unlock()
	if name == "" || destination == "" || !validPath(name) || !validPath(destination) {
		return ErrPath
	}
	original, _, err := source.descriptor(name)
	if err != nil {
		return err
	}
	defer original.Close()
	if name == destination {
		return nil
	}
	from, _, err := source.descriptor(parentPath(name))
	if err != nil {
		return err
	}
	defer from.Close()
	to, _, err := source.descriptor(parentPath(destination))
	if err != nil {
		return err
	}
	defer to.Close()
	// Do not replace a protected link, special file or nested mount either.
	existing, _, err := source.descriptor(destination)
	if err == nil {
		existing.Close()
		if !overwrite {
			return ErrConflict
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	flags := uint(unix.RENAME_NOREPLACE)
	if overwrite {
		flags = 0
	}
	if err := unix.Renameat2(int(from.Fd()), path.Base(name), int(to.Fd()), path.Base(destination), flags); err != nil {
		if errors.Is(err, unix.EEXIST) || errors.Is(err, unix.ENOTEMPTY) {
			return ErrConflict
		}
		return err
	}
	if err := syncDirectory(from); err != nil {
		return err
	}
	return syncDirectory(to)
}

type removal struct {
	name string
	stat unix.Stat_t
}

// Bound and validate the whole tree before deleting anything. A protected child
// rejects the operation rather than silently removing Git metadata or links.
func (source *Source) planRemoval(name string, recursive bool, depth int, entries *[]removal) error {
	if depth > 64 || len(*entries) >= maxDirectoryEntries {
		return ErrTooLarge
	}
	file, stat, err := source.descriptor(name)
	if err != nil {
		return err
	}
	defer file.Close()
	if stat.Mode&unix.S_IFMT == unix.S_IFDIR && recursive {
		directory, err := reopen(file, unix.O_RDONLY|unix.O_DIRECTORY)
		if err != nil {
			return err
		}
		children, readError := directory.ReadDir(maxDirectoryEntries + 1)
		directory.Close()
		if readError != nil && !errors.Is(readError, io.EOF) {
			return readError
		}
		if len(children)+len(*entries) > maxDirectoryEntries {
			return ErrTooLarge
		}
		for _, child := range children {
			if err := source.planRemoval(path.Join(name, child.Name()), true, depth+1, entries); err != nil {
				return err
			}
		}
	}
	if len(*entries) >= maxDirectoryEntries {
		return ErrTooLarge
	}
	*entries = append(*entries, removal{name: name, stat: stat})
	return nil
}

func (source *Source) Delete(name string, recursive bool) error {
	source.life.RLock()
	defer source.life.RUnlock()
	source.writes.Lock()
	defer source.writes.Unlock()
	if name == "" || !validPath(name) {
		return ErrPath
	}
	entries := make([]removal, 0)
	if err := source.planRemoval(name, recursive, 0, &entries); err != nil {
		return err
	}
	for _, entry := range entries {
		current, stat, err := source.descriptor(entry.name)
		if err != nil {
			return err
		}
		current.Close()
		if stat.Ino != entry.stat.Ino || stat.Dev != entry.stat.Dev || stat.Mode != entry.stat.Mode {
			return ErrConflict
		}
		parent, _, err := source.descriptor(parentPath(entry.name))
		if err != nil {
			return err
		}
		flags := 0
		if stat.Mode&unix.S_IFMT == unix.S_IFDIR {
			flags = unix.AT_REMOVEDIR
		}
		err = unix.Unlinkat(int(parent.Fd()), path.Base(entry.name), flags)
		if err == nil {
			err = syncDirectory(parent)
		}
		parent.Close()
		if errors.Is(err, unix.ENOTEMPTY) || errors.Is(err, unix.EEXIST) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
	}
	return nil
}
