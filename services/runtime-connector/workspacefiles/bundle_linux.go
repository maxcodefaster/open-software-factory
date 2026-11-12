package workspacefiles

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime/debug"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const SourceChunkBytes = 1 << 20
const MaxSourceBundleBytes int64 = 4 << 30
const maxSourceEntries = 200_000

type Bundle struct {
	Version int      `json:"version"`
	Bytes   int64    `json:"bytes"`
	SHA256  string   `json:"sha256"`
	Chunks  []string `json:"chunks"`
}

func bundlePath(name string) bool {
	return name == "." || (name != "" && len(name) <= 4096 && utf8.ValidString(name) &&
		!strings.ContainsAny(name, "\x00\\") && !strings.HasPrefix(name, "/") &&
		path.Clean(name) == name && name != ".." && !strings.HasPrefix(name, "../"))
}
func bundleLink(name, target string) bool {
	return target != "" && !strings.HasPrefix(target, "/") && !strings.ContainsAny(target, "\x00\\") &&
		bundlePath(path.Clean(path.Join(path.Dir(name), target)))
}

// Only development UID/GID 1000 is qualified for this Source slice. Other
// mappings, privileged modes, device nodes and non-user xattrs are refused,
// never silently flattened. Docker/volumes are outside this checkout boundary.
func bundleHeader(name string, info os.FileInfo) (*tar.Header, error) {
	return sourceBundleHeader(name, info, false)
}

func retainedRootLockfile(name string, uid, gid int, mode int64, kind byte) bool {
	return (name == ".devcontainer/devcontainer-lock.json" || name == ".devcontainer-lock.json") && uid == 0 && gid == 0 && mode == 0644 && kind == tar.TypeReg
}

func sourceBundleHeader(name string, info os.FileInfo, retainedLockfile bool) (*tar.Header, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Mode&07000 != 0 {
		return nil, errors.New("unsupported Source ownership or mode")
	}
	h, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return nil, errors.New("unsupported Source entry")
	}
	if stat.Uid != 1000 || stat.Gid != 1000 {
		if !retainedLockfile || stat.Nlink != 1 || !retainedRootLockfile(name, int(stat.Uid), int(stat.Gid), h.Mode, h.Typeflag) {
			return nil, errors.New("unsupported Source ownership or mode")
		}
	}
	h.Name, h.Uid, h.Gid, h.Uname, h.Gname = name, int(stat.Uid), int(stat.Gid), "", ""
	h.Format = tar.FormatPAX
	h.ModTime = time.Unix(stat.Mtim.Sec, stat.Mtim.Nsec)
	h.AccessTime = time.Unix(stat.Atim.Sec, stat.Atim.Nsec)
	h.ChangeTime = time.Time{} // Linux ctime is not settable; it is not claimed as restored.
	return h, nil
}

func sourceXattrs(filename string) (map[string]string, error) {
	n, err := unix.Llistxattr(filename, nil)
	if err != nil {
		return nil, errors.New("Source xattrs could not be enumerated")
	}
	if n > 1<<20 {
		return nil, ErrTooLarge
	}
	data := make([]byte, n)
	if _, err := unix.Llistxattr(filename, data); err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, key := range strings.Split(strings.TrimSuffix(string(data), "\x00"), "\x00") {
		if key == "" {
			continue
		}
		if !strings.HasPrefix(key, "user.") {
			return nil, errors.New("unsupported Source xattr namespace")
		}
		size, err := unix.Lgetxattr(filename, key, nil)
		if err != nil || size > 1<<20 {
			return nil, errors.New("Source xattr is unavailable")
		}
		value := make([]byte, size)
		if _, err := unix.Lgetxattr(filename, key, value); err != nil {
			return nil, err
		}
		result["FACTORY.xattr."+base64.RawURLEncoding.EncodeToString([]byte(key))] = base64.StdEncoding.EncodeToString(value)
	}
	return result, nil
}

func (source *Source) walkBundle(visit func(string, error) error) error {
	var walk func(string) error
	walk = func(name string) error {
		fd, err := unix.Openat2(int(source.root.Fd()), name, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC | unix.O_NOFOLLOW, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV})
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), name)
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return err
		}
		filename := source.root.Name()
		if name != "." {
			filename += "/" + name
		}
		if err := visit(filename, nil); err != nil {
			return err
		}
		if !info.IsDir() {
			return nil
		}
		directory, err := reopen(file, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOATIME)
		if err != nil {
			return err
		}
		defer directory.Close()
		entries, err := directory.ReadDir(maxSourceEntries + 1)
		if err != nil && err != io.EOF {
			return err
		}
		if len(entries) > maxSourceEntries {
			return ErrTooLarge
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			child := path.Join(name, entry.Name())
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(".")
}

func sameBundleStat(expected syscall.Stat_t, current unix.Stat_t) bool {
	return uint64(expected.Dev) == uint64(current.Dev) && expected.Ino == current.Ino && expected.Mode == current.Mode && expected.Uid == current.Uid && expected.Gid == current.Gid && expected.Size == current.Size && expected.Nlink == current.Nlink &&
		expected.Mtim.Sec == current.Mtim.Sec && expected.Mtim.Nsec == current.Mtim.Nsec && expected.Atim.Sec == current.Atim.Sec && expected.Atim.Nsec == current.Atim.Nsec &&
		expected.Ctim.Sec == current.Ctim.Sec && expected.Ctim.Nsec == current.Ctim.Nsec
}

func (source *Source) verifyBundleEntry(name string, expected syscall.Stat_t, attrs map[string]string) error {
	fd, err := unix.Openat2(int(source.root.Fd()), name, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC | unix.O_NOFOLLOW, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV})
	if err != nil {
		return ErrConflict
	}
	defer unix.Close(fd)
	var current unix.Stat_t
	if unix.Fstat(fd, &current) != nil {
		return ErrConflict
	}
	// Plain Linux readlink preservation changes only the link's un-restorable
	// ctime. Native archive views are read-only/noatime and need no exception.
	if expected.Mode&unix.S_IFMT == unix.S_IFLNK && !readOnlyNoAtime(source.root) {
		expected.Ctim.Sec, expected.Ctim.Nsec = current.Ctim.Sec, current.Ctim.Nsec
	}
	if !sameBundleStat(expected, current) {
		return ErrConflict
	}
	filename := source.root.Name()
	if name != "." {
		filename += "/" + name
	}
	actual, err := sourceXattrs(filename)
	if err != nil {
		return err
	}
	wanted := map[string]string{}
	for key, value := range attrs {
		if strings.HasPrefix(key, "FACTORY.xattr.") {
			wanted[key] = value
		}
	}
	if !reflect.DeepEqual(actual, wanted) {
		return ErrConflict
	}
	return nil
}

func (source *Source) bundleChildren(name string) ([]string, error) {
	fd, err := unix.Openat2(int(source.root.Fd()), name, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NOATIME, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV})
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	entries, err := file.ReadDir(maxSourceEntries + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) > maxSourceEntries {
		return nil, ErrTooLarge
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, nil
}

func (source *Source) verifyBundleChildren(name string, expected []string) error {
	current, err := source.bundleChildren(name)
	if err != nil {
		return err
	}
	if len(current) != len(expected) {
		return ErrConflict
	}
	for index, name := range current {
		if name != expected[index] {
			return ErrConflict
		}
	}
	return nil
}

// ExportBundle is called only under Service.writes after its writer has been
// fenced. Actor callers additionally stop/drain their private Docker containers
// and serialize Parent Git operations before reaching this operation.
func (source *Source) ExportBundle(output *os.File) (Bundle, error) {
	return source.exportBundle(output, false)
}

// ExportRetainedLockfileBundle is a recovery-only archive, never a v1 Source
// generation. Its one additional metadata case is the observed CLI-generated
// root:root 0644 regular lockfile. It preserves ownership rather than projecting
// it, and requires private root to read with O_NOATIME. Normal Source services
// remain development UID 1000 and continue refusing this metadata.
func (source *Source) ExportRetainedLockfileBundle(output *os.File) (Bundle, error) {
	if os.Geteuid() != 0 {
		return Bundle{}, errors.New("retained Source preservation requires private root")
	}
	bundle, err := source.exportBundle(output, true)
	if err == nil {
		bundle.Version = 2
	}
	return bundle, err
}

func (source *Source) exportBundle(output *os.File, retainedLockfile bool) (Bundle, error) {
	source.life.RLock()
	defer source.life.RUnlock()
	source.writes.Lock()
	defer source.writes.Unlock()
	if source.root == nil {
		return Bundle{}, os.ErrClosed
	}
	view := source
	if source.archiveRoot != nil {
		view = &Source{root: source.archiveRoot}
	}
	immutableAtime := readOnlyNoAtime(view.root)
	type entry struct {
		h    *tar.Header
		stat syscall.Stat_t
	}
	var entries []entry
	links := map[[2]uint64][]int{}
	root := view.root.Name()
	var total int64
	err := view.walkBundle(func(filename string, walkErr error) error {
		if walkErr != nil {
			return errors.New("complete Source enumeration failed")
		}
		name, err := filepath.Rel(root, filename)
		if err != nil || !bundlePath(name) || len(entries) >= maxSourceEntries {
			return ErrPath
		}
		info, err := os.Lstat(filename)
		if err != nil {
			return err
		}
		h, err := sourceBundleHeader(name, info, retainedLockfile)
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir && h.Typeflag != tar.TypeSymlink {
			return errors.New("unsupported Source entry type")
		}
		if name == ".git" && h.Typeflag != tar.TypeDir {
			return errors.New("external Git directory is unsupported")
		}
		if h.Typeflag == tar.TypeSymlink {
			h.Linkname, err = os.Readlink(filename)
			if err != nil || !bundleLink(name, h.Linkname) {
				return ErrPath
			}
			// readlink can update the link's atime even for an O_PATH descriptor.
			// Keep the supported timestamp exact across immutable export retries.
			if !immutableAtime {
				if err := unix.UtimesNanoAt(unix.AT_FDCWD, filename, []unix.Timespec{unix.NsecToTimespec(h.AccessTime.UnixNano()), unix.NsecToTimespec(h.ModTime.UnixNano())}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
					return err
				}
			}
		}
		h.PAXRecords, err = sourceXattrs(filename)
		if err != nil {
			return err
		}
		stat := *info.Sys().(*syscall.Stat_t)
		if h.Typeflag == tar.TypeReg {
			total += stat.Size
			if total > MaxSourceBundleBytes {
				return ErrTooLarge
			}
			key := [2]uint64{uint64(stat.Dev), stat.Ino}
			links[key] = append(links[key], len(entries))
		}
		entries = append(entries, entry{h, stat})
		return nil
	})
	if err != nil {
		return Bundle{}, err
	}
	for _, indices := range links {
		first := entries[indices[0]]
		if uint64(len(indices)) != uint64(first.stat.Nlink) {
			return Bundle{}, errors.New("Source hardlink leaves the checkout")
		}
		for _, index := range indices[1:] {
			entries[index].h.Typeflag = tar.TypeLink
			entries[index].h.Linkname = first.h.Name
			entries[index].h.Size = 0
		}
	}
	w := tar.NewWriter(output)
	for _, entry := range entries {
		if err := w.WriteHeader(entry.h); err != nil {
			return Bundle{}, err
		}
		if entry.h.Typeflag != tar.TypeReg {
			continue
		}
		fd, err := unix.Openat2(int(view.root.Fd()), entry.h.Name, &unix.OpenHow{Flags: unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NOATIME, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV})
		if err != nil {
			return Bundle{}, err
		}
		file := os.NewFile(uintptr(fd), entry.h.Name)
		var before, after unix.Stat_t
		err = unix.Fstat(fd, &before)
		if err == nil && !sameBundleStat(entry.stat, before) {
			err = ErrConflict
		}
		if err == nil {
			err = writeMappedSource(w, fd, entry.h.Size)
		}
		if err == nil {
			err = unix.Fstat(fd, &after)
		}
		file.Close()
		if err != nil || before.Ino != after.Ino || before.Size != after.Size || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
			return Bundle{}, ErrConflict
		}
	}
	// An unexpected writer can add an entry after its parent was enumerated or
	// change mode/xattrs without changing file mtime. Reject that incomplete tree
	// before publishing any manifest. Link inode/ownership/target metadata is
	// checked too; only normal Linux readlink's known ctime effect is excluded.
	children := map[string][]string{}
	for _, entry := range entries {
		if entry.h.Typeflag == tar.TypeDir {
			if _, exists := children[entry.h.Name]; !exists {
				children[entry.h.Name] = []string{}
			}
		}
		if entry.h.Name != "." {
			parent := path.Dir(entry.h.Name)
			children[parent] = append(children[parent], path.Base(entry.h.Name))
		}
	}
	for name, names := range children {
		sort.Strings(names)
		if err := view.verifyBundleChildren(name, names); err != nil {
			return Bundle{}, err
		}
	}
	for _, entry := range entries {
		if err := view.verifyBundleEntry(entry.h.Name, entry.stat, entry.h.PAXRecords); err != nil {
			return Bundle{}, err
		}
	}
	if err := w.Close(); err != nil {
		return Bundle{}, err
	}
	if err := output.Sync(); err != nil {
		return Bundle{}, err
	}
	return InspectBundle(output)
}

// The pinned gVisor runtime accepts O_NOATIME but read/pread/sendfile still
// update access time. Read-only mappings avoid that mutation on both the
// qualified native profile and Linux. Map only one bounded chunk at a time;
// never map an entire large checkout file or repair its timestamps afterward.
func writeMappedSource(output io.Writer, fd int, size int64) (err error) {
	previous := debug.SetPanicOnFault(true)
	defer debug.SetPanicOnFault(previous)
	defer func() {
		// A foreign truncate after the writer drain must fail closed instead of
		// crashing the Source process with SIGBUS or publishing a partial bundle.
		if recover() != nil {
			err = ErrConflict
		}
	}()
	for offset := int64(0); offset < size; offset += SourceChunkBytes {
		data, mapErr := unix.Mmap(fd, offset, int(min(int64(SourceChunkBytes), size-offset)), unix.PROT_READ, unix.MAP_PRIVATE)
		if mapErr != nil {
			return mapErr
		}
		err = func() error {
			defer unix.Munmap(data)
			n, writeErr := output.Write(data)
			if writeErr != nil {
				return writeErr
			}
			if n != len(data) {
				return io.ErrShortWrite
			}
			return nil
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

func InspectBundle(file *os.File) (Bundle, error) {
	info, err := file.Stat()
	if err != nil || info.Size() > MaxSourceBundleBytes || info.Size() == 0 {
		return Bundle{}, ErrTooLarge
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return Bundle{}, err
	}
	result := Bundle{Version: 1, Bytes: info.Size()}
	hash := sha256.New()
	for {
		data := make([]byte, SourceChunkBytes)
		n, err := io.ReadFull(file, data)
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return Bundle{}, err
		}
		if n != 0 {
			hash.Write(data[:n])
			chunk := sha256.Sum256(data[:n])
			result.Chunks = append(result.Chunks, hex.EncodeToString(chunk[:]))
		}
		if err != nil {
			break
		}
	}
	result.SHA256 = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}

// MaterializeBundle creates a new, private staging checkout. It never writes
// through an existing tree, follows archive links, reclones, or deletes old data.
// The caller publishes this directory only after complete validation succeeds.
func MaterializeBundle(input *os.File, destination string) error {
	return materializeBundle(input, destination, false)
}

// Recovery qualification only. No existing Source owner invokes this function,
// and it never publishes over a canonical tree. Non-root materialization cannot
// silently flatten the archived root ownership to the development identity.
func MaterializeRetainedLockfileBundle(input *os.File, destination string) error {
	if os.Geteuid() != 0 {
		return errors.New("retained Source materialization requires private root")
	}
	return materializeBundle(input, destination, true)
}

func materializeBundle(input *os.File, destination string, retainedLockfile bool) error {
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		return err
	}
	type item struct{ h tar.Header }
	items := map[string]item{}
	var ordered []string
	reader := tar.NewReader(io.LimitReader(input, MaxSourceBundleBytes+1))
	var total int64
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("invalid Source archive")
		}
		if !bundlePath(h.Name) || h.Mode < 0 || h.Mode & ^int64(0777) != 0 || len(items) >= maxSourceEntries {
			return ErrPath
		}
		if (h.Uid != 1000 || h.Gid != 1000) && (!retainedLockfile || !retainedRootLockfile(h.Name, h.Uid, h.Gid, h.Mode, h.Typeflag)) {
			return ErrPath
		}
		if _, exists := items[h.Name]; exists {
			return errors.New("duplicate Source archive path")
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir && h.Typeflag != tar.TypeSymlink && h.Typeflag != tar.TypeLink {
			return errors.New("unsupported Source archive entry")
		}
		if h.Typeflag == tar.TypeSymlink && !bundleLink(h.Name, h.Linkname) {
			return ErrPath
		}
		if h.Typeflag == tar.TypeLink && (!bundlePath(h.Linkname) || h.Linkname == ".") {
			return ErrPath
		}
		if h.Name == "." && h.Typeflag != tar.TypeDir {
			return ErrPath
		}
		for key, value := range h.PAXRecords {
			if key == "path" || key == "linkpath" || key == "mtime" || key == "atime" {
				continue
			}
			if !strings.HasPrefix(key, "FACTORY.xattr.") {
				return errors.New("unsupported Source PAX metadata")
			}
			name, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(key, "FACTORY.xattr."))
			if err != nil || !strings.HasPrefix(string(name), "user.") || strings.ContainsRune(string(name), 0) {
				return ErrPath
			}
			if _, err := base64.StdEncoding.DecodeString(value); err != nil {
				return ErrPath
			}
		}
		total += h.Size
		if total > MaxSourceBundleBytes {
			return ErrTooLarge
		}
		items[h.Name] = item{*h}
		ordered = append(ordered, h.Name)
	}
	if root, ok := items["."]; !ok || root.h.Typeflag != tar.TypeDir {
		return ErrPath
	}
	for name, entry := range items {
		if name != "." {
			parent, exists := items[path.Dir(name)]
			if !exists || parent.h.Typeflag != tar.TypeDir {
				return ErrPath
			}
		}
		if entry.h.Typeflag == tar.TypeLink {
			target, exists := items[entry.h.Linkname]
			if !exists || target.h.Typeflag != tar.TypeReg || entry.h.Uid != target.h.Uid || entry.h.Gid != target.h.Gid || entry.h.Mode != target.h.Mode || !entry.h.ModTime.Equal(target.h.ModTime) || !entry.h.AccessTime.Equal(target.h.AccessTime) || !reflect.DeepEqual(entry.h.PAXRecords, target.h.PAXRecords) {
				return ErrPath
			}
		}
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	// Parents must precede children regardless of adversarial archive order.
	sort.Slice(ordered, func(i, j int) bool {
		return strings.Count(ordered[i], "/") < strings.Count(ordered[j], "/") || (strings.Count(ordered[i], "/") == strings.Count(ordered[j], "/") && ordered[i] < ordered[j])
	})
	for _, name := range ordered {
		if name != "." && items[name].h.Typeflag == tar.TypeDir {
			if err := os.Mkdir(filepath.Join(destination, name), 0700); err != nil {
				return err
			}
		}
	}
	input.Seek(0, io.SeekStart)
	reader = tar.NewReader(input)
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		file, err := os.OpenFile(filepath.Join(destination, h.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(file, reader, h.Size)
		syncErr := file.Sync()
		file.Close()
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
	}
	for _, name := range ordered {
		h := items[name].h
		filename := filepath.Join(destination, name)
		if h.Typeflag == tar.TypeLink {
			if err := os.Link(filepath.Join(destination, h.Linkname), filename); err != nil {
				return err
			}
		}
		if h.Typeflag == tar.TypeSymlink {
			if err := os.Symlink(h.Linkname, filename); err != nil {
				return err
			}
		}
	}
	for i := len(ordered) - 1; i >= 0; i-- {
		name := ordered[i]
		h := items[name].h
		filename := filepath.Join(destination, name)
		if err := os.Lchown(filename, h.Uid, h.Gid); err != nil {
			return err
		}
		if h.Typeflag != tar.TypeSymlink {
			if err := os.Chmod(filename, os.FileMode(h.Mode)); err != nil {
				return err
			}
		}
		for key, value := range h.PAXRecords {
			if strings.HasPrefix(key, "FACTORY.xattr.") {
				attr, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(key, "FACTORY.xattr."))
				data, _ := base64.StdEncoding.DecodeString(value)
				if err := unix.Lsetxattr(filename, string(attr), data, 0); err != nil {
					return err
				}
			}
		}
		atime := h.AccessTime
		if atime.IsZero() {
			atime = h.ModTime
		}
		if err := unix.UtimesNanoAt(unix.AT_FDCWD, filename, []unix.Timespec{unix.NsecToTimespec(atime.UnixNano()), unix.NsecToTimespec(h.ModTime.UnixNano())}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
	}
	return nil
}
