package artifacts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	OpenCodeArtifactsRoot             = "/opt/factory/opencode"
	OpenCodeArtifactsManifestMaxBytes = 4 << 10
	openCodeArtifactsManifestName     = "manifest.json"
	openCodeArtifactsMaxEntries       = 100000
	openCodeArtifactsMaxFileBytes     = 512 << 20
	openCodeArtifactsMaxPayloadBytes  = 4 << 30
)

var errOpenCodeArtifacts = errors.New("OpenCode artifacts are unavailable or do not match the expected manifest")

// v1 binds the complete server tree without transporting its per-file records.
type openCodeArtifactsManifest struct {
	Version int                    `json:"version"`
	Server  openCodeArtifactTree   `json:"server"`
	Glibc   openCodeArtifactBinary `json:"glibc"`
	Musl    openCodeArtifactBinary `json:"musl"`
}

type openCodeArtifactTree struct {
	SHA256 string `json:"sha256"`
	Count  int    `json:"count"`
	Size   int64  `json:"size"`
}

type openCodeArtifactBinary struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   uint32 `json:"mode"`
}

// Internal canonical hash records only. Directory sizes are zero; symlink
// size/hash describe relative target text. No UIDs or timestamps enter identity.
type openCodeArtifactEntry struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Mode   uint32 `json:"mode"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
	Target string `json:"target,omitempty"`
}

type openCodeArtifactScan struct {
	entries []openCodeArtifactEntry
	size    int64
}

// OpenCodeArtifactsManifest emits canonical JSON for the final shipped tool root.
// Only server/, glibc/bun and musl/bun enter the manifest, never runtime data or
// the manifest file itself. It does not install or execute any packaged code.
func OpenCodeArtifactsManifest(root string) ([]byte, error) {
	directory, err := openOpenCodeArtifactsRoot(root)
	if err != nil {
		return nil, errOpenCodeArtifacts
	}
	defer directory.Close()
	var scan openCodeArtifactScan
	if err := scan.server(directory); err != nil {
		return nil, errOpenCodeArtifacts
	}
	server, err := scan.fingerprint()
	if err != nil {
		return nil, errOpenCodeArtifacts
	}
	manifest := openCodeArtifactsManifest{Version: 1, Server: server}
	for _, libc := range []string{"glibc", "musl"} {
		variant, err := openOpenCodeArtifactDirectory(directory, libc)
		if err != nil {
			return nil, errOpenCodeArtifacts
		}
		// These are fixed binary payloads, not additional package/data trees.
		file, err := variant.Open(".")
		if err == nil {
			children, readErr := file.ReadDir(2)
			closeErr := file.Close()
			if (readErr != nil && !errors.Is(readErr, io.EOF)) || closeErr != nil ||
				len(children) != 1 || children[0].Name() != "bun" {
				err = errOpenCodeArtifacts
			}
		}
		if err == nil {
			var entry openCodeArtifactEntry
			entry, err = readOpenCodeArtifactFile(variant, "bun", libc+"/bun")
			if err == nil {
				binary := openCodeArtifactBinary{SHA256: entry.SHA256, Size: entry.Size, Mode: entry.Mode}
				if libc == "glibc" {
					manifest.Glibc = binary
				} else {
					manifest.Musl = binary
				}
			}
		}
		closeErr := variant.Close()
		if err != nil || closeErr != nil {
			return nil, errOpenCodeArtifacts
		}
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return nil, errOpenCodeArtifacts
	}
	if _, err := parseOpenCodeArtifactsManifest(encoded); err != nil {
		return nil, errOpenCodeArtifacts
	}
	return encoded, nil
}

// ReadOpenCodeArtifactsManifest reads the shipped manifest.json and returns its
// canonical bytes and lowercase SHA-256 hex digest. The caller supplies the
// trusted package root; this is not evidence about an installed primary's files.
// VerifyOpenCodeArtifacts independently checks those files against these bytes.
func ReadOpenCodeArtifactsManifest(root string) (manifest []byte, digest string, err error) {
	directory, err := openOpenCodeArtifactsRoot(root)
	if err != nil {
		return nil, "", errOpenCodeArtifacts
	}
	defer directory.Close()
	info, err := directory.Lstat(openCodeArtifactsManifestName)
	if err != nil || !info.Mode().IsRegular() || !safeOpenCodeArtifactMode(info.Mode()) || info.Size() > OpenCodeArtifactsManifestMaxBytes {
		return nil, "", errOpenCodeArtifacts
	}
	file, err := directory.OpenFile(openCodeArtifactsManifestName, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, "", errOpenCodeArtifacts
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameOpenCodeArtifactFile(info, opened) {
		return nil, "", errOpenCodeArtifacts
	}
	content, err := io.ReadAll(io.LimitReader(file, OpenCodeArtifactsManifestMaxBytes+1))
	after, statErr := file.Stat()
	current, pathErr := directory.Lstat(openCodeArtifactsManifestName)
	if err != nil || statErr != nil || pathErr != nil || len(content) > OpenCodeArtifactsManifestMaxBytes ||
		!sameOpenCodeArtifactFile(info, after) || !sameOpenCodeArtifactFile(info, current) {
		return nil, "", errOpenCodeArtifacts
	}
	parsed, err := parseOpenCodeArtifactsManifest(content)
	if err != nil {
		return nil, "", errOpenCodeArtifacts
	}
	manifest, err = json.Marshal(parsed)
	if err != nil {
		return nil, "", errOpenCodeArtifacts
	}
	sum := sha256.Sum256(manifest)
	return manifest, hex.EncodeToString(sum[:]), nil
}

// OpenCodeArtifactsSize returns the bounded payload size of a validated v1
// manifest: regular file bytes plus relative symlink target bytes, both Buns
// included. Directory metadata and the JSON encoding itself are not payload.
func OpenCodeArtifactsSize(manifest []byte) (int64, error) {
	parsed, err := parseOpenCodeArtifactsManifest(manifest)
	if err != nil {
		return 0, errOpenCodeArtifacts
	}
	return parsed.Server.Size + parsed.Glibc.Size + parsed.Musl.Size, nil
}

// VerifyOpenCodeArtifacts checks the installed server tree and /bun against the
// caller's expected shipped manifest and selected libc. It never reads the
// installed manifest, image labels, sessions or either unselected binary.
func VerifyOpenCodeArtifacts(root string, manifest []byte, libc string) error {
	if libc != "glibc" && libc != "musl" {
		return errOpenCodeArtifacts
	}
	expected, err := parseOpenCodeArtifactsManifest(manifest)
	if err != nil {
		return errOpenCodeArtifacts
	}
	directory, err := openOpenCodeArtifactsRoot(root)
	if err != nil {
		return errOpenCodeArtifacts
	}
	defer directory.Close()
	var scan openCodeArtifactScan
	if err := scan.server(directory); err != nil {
		return errOpenCodeArtifacts
	}
	server, err := scan.fingerprint()
	if err != nil || server != expected.Server {
		return errOpenCodeArtifacts
	}
	bun := expected.Musl
	if libc == "glibc" {
		bun = expected.Glibc
	}
	installed, err := readOpenCodeArtifactFile(directory, "bun", libc+"/bun")
	if err != nil || (openCodeArtifactBinary{SHA256: installed.SHA256, Size: installed.Size, Mode: installed.Mode}) != bun {
		return errOpenCodeArtifacts
	}
	return nil
}

// ResetOpenCodeArtifacts removes only the installed server tree and Bun file.
// Root/ancestor symlinks are refused. Payload symlinks are unlinked, never
// followed; sibling manifests, libc packages, Skills and session data stay put.
func ResetOpenCodeArtifacts(root string) error {
	missing, err := missingOpenCodeArtifactsRoot(root)
	if err != nil {
		return errOpenCodeArtifacts
	}
	if missing {
		// Fresh containers have no installed payload. Do not create anything:
		// Parent owns setup and copying after this safe, read-only no-op.
		return nil
	}
	directory, err := openOpenCodeArtifactsRoot(root)
	if err != nil {
		return errOpenCodeArtifacts
	}
	defer directory.Close()
	for _, name := range []string{"server", "bun"} {
		info, err := directory.Lstat(name)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || (name == "server" && !info.IsDir() && info.Mode()&os.ModeSymlink == 0) ||
			(name == "bun" && !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0) {
			return errOpenCodeArtifacts
		}
	}
	if err := directory.RemoveAll("server"); err != nil {
		return errOpenCodeArtifacts
	}
	if err := directory.Remove("bun"); err != nil && !os.IsNotExist(err) {
		return errOpenCodeArtifacts
	}
	return nil
}

func missingOpenCodeArtifactsRoot(root string) (bool, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == string(filepath.Separator) {
		return false, errOpenCodeArtifacts
	}
	current := string(filepath.Separator)
	for _, component := range strings.Split(strings.TrimPrefix(root, current), string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return true, nil
		}
		if err != nil || !info.IsDir() {
			// Lstat deliberately does not follow an existing ancestor symlink.
			return false, errOpenCodeArtifacts
		}
	}
	return false, nil
}

func openOpenCodeArtifactsRoot(root string) (*os.Root, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == string(filepath.Separator) {
		return nil, errOpenCodeArtifacts
	}
	// This fixed tool root must not be redirected by a symlink at any ancestor.
	// Tests can resolve their owned temporary directory before supplying it.
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || resolved != root {
		return nil, errOpenCodeArtifacts
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || !safeOpenCodeArtifactMode(info.Mode()) {
		return nil, errOpenCodeArtifacts
	}
	directory, err := os.OpenRoot(root)
	if err != nil {
		return nil, errOpenCodeArtifacts
	}
	opened, err := directory.Stat(".")
	if err != nil || !sameOpenCodeArtifactFile(info, opened) {
		directory.Close()
		return nil, errOpenCodeArtifacts
	}
	return directory, nil
}

func openOpenCodeArtifactDirectory(root *os.Root, name string) (*os.Root, error) {
	info, err := root.Lstat(name)
	if err != nil || !info.IsDir() || !safeOpenCodeArtifactMode(info.Mode()) {
		return nil, errOpenCodeArtifacts
	}
	directory, err := root.OpenRoot(name)
	if err != nil {
		return nil, errOpenCodeArtifacts
	}
	opened, err := directory.Stat(".")
	current, pathErr := root.Lstat(name)
	if err != nil || pathErr != nil || !sameOpenCodeArtifactFile(info, opened) || !sameOpenCodeArtifactFile(info, current) {
		directory.Close()
		return nil, errOpenCodeArtifacts
	}
	return directory, nil
}

func (scan *openCodeArtifactScan) add(entry openCodeArtifactEntry) error {
	if len(scan.entries) >= openCodeArtifactsMaxEntries || entry.Size < 0 ||
		entry.Size > openCodeArtifactsMaxPayloadBytes-scan.size {
		return errOpenCodeArtifacts
	}
	scan.size += entry.Size
	scan.entries = append(scan.entries, entry)
	return nil
}

func (scan *openCodeArtifactScan) fingerprint() (openCodeArtifactTree, error) {
	var tree openCodeArtifactTree
	sort.Slice(scan.entries, func(i, j int) bool { return scan.entries[i].Path < scan.entries[j].Path })
	hash := sha256.New()
	hash.Write([]byte("factory-opencode-server-tree-v1\x00"))
	encoder := json.NewEncoder(hash)
	previous := ""
	required := 0
	for _, entry := range scan.entries {
		if entry.Path <= previous || !validOpenCodeArtifactPath(entry.Path) {
			return tree, errOpenCodeArtifacts
		}
		previous = entry.Path
		if entry.Path == "server/server.mjs" || entry.Path == "server/input-stop.mjs" {
			if entry.Type != "file" || entry.Size == 0 {
				return tree, errOpenCodeArtifacts
			}
			required++
		}
		// Each sorted record is canonical JSON terminated by one newline.
		// Streaming keeps the full record list off the Parent/Child wire and
		// avoids constructing a second multi-megabyte JSON buffer just to hash it.
		if encoder.Encode(entry) != nil {
			return tree, errOpenCodeArtifacts
		}
	}
	if required != 2 {
		return tree, errOpenCodeArtifacts
	}
	return openCodeArtifactTree{SHA256: hex.EncodeToString(hash.Sum(nil)), Count: len(scan.entries), Size: scan.size}, nil
}

func (scan *openCodeArtifactScan) server(root *os.Root) error {
	info, err := root.Lstat("server")
	if err != nil {
		return errOpenCodeArtifacts
	}
	server, err := openOpenCodeArtifactDirectory(root, "server")
	if err != nil {
		return err
	}
	defer server.Close()
	if err := scan.tree(server, server, "server"); err != nil {
		return err
	}
	current, err := root.Lstat("server")
	if err != nil || !sameOpenCodeArtifactFile(info, current) {
		return errOpenCodeArtifacts
	}
	return nil
}

func (scan *openCodeArtifactScan) tree(directory, server *os.Root, prefix string) error {
	if !validOpenCodeArtifactPath(prefix) || strings.Count(prefix, "/") > 256 {
		return errOpenCodeArtifacts
	}
	info, err := directory.Stat(".")
	if err != nil || !info.IsDir() || !safeOpenCodeArtifactMode(info.Mode()) {
		return errOpenCodeArtifacts
	}
	if err := scan.add(openCodeArtifactEntry{Path: prefix, Type: "directory", Mode: uint32(info.Mode().Perm())}); err != nil {
		return err
	}
	file, err := directory.Open(".")
	if err != nil {
		return errOpenCodeArtifacts
	}
	defer file.Close()
	for {
		children, readErr := file.ReadDir(256)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return errOpenCodeArtifacts
		}
		for _, child := range children {
			name := child.Name()
			full := prefix + "/" + name
			if !validOpenCodeArtifactPath(full) {
				return errOpenCodeArtifacts
			}
			info, err := directory.Lstat(name)
			if err != nil {
				return errOpenCodeArtifacts
			}
			switch {
			case info.IsDir():
				nested, err := openOpenCodeArtifactDirectory(directory, name)
				if err != nil {
					return err
				}
				err = scan.tree(nested, server, full)
				closeErr := nested.Close()
				current, pathErr := directory.Lstat(name)
				if err != nil || closeErr != nil || pathErr != nil || !sameOpenCodeArtifactFile(info, current) {
					return errOpenCodeArtifacts
				}
			case info.Mode().IsRegular():
				entry, err := readOpenCodeArtifactFile(directory, name, full)
				if err != nil {
					return err
				}
				if err := scan.add(entry); err != nil {
					return err
				}
			case info.Mode()&os.ModeSymlink != 0:
				target, err := directory.Readlink(name)
				if err != nil || !safeOpenCodeArtifactLink(full, target) {
					return errOpenCodeArtifacts
				}
				// Root follows only relative links that remain in the server tree,
				// including indirect links. Dangling, looping and escaped links fail.
				resolved, err := server.Stat(strings.TrimPrefix(full, "server/"))
				current, pathErr := directory.Lstat(name)
				if err != nil || pathErr != nil || !safeOpenCodeArtifactMode(resolved.Mode()) || !sameOpenCodeArtifactFile(info, current) {
					return errOpenCodeArtifacts
				}
				sum := sha256.Sum256([]byte(target))
				// Symlink permission bits are ignored on Linux, and can differ on
				// the test host. Normalize that non-authoritative mode to 0777.
				if err := scan.add(openCodeArtifactEntry{Path: full, Type: "symlink", Mode: 0777,
					Size: int64(len(target)), SHA256: hex.EncodeToString(sum[:]), Target: target}); err != nil {
					return err
				}
			default:
				return errOpenCodeArtifacts
			}
		}
		if errors.Is(readErr, io.EOF) {
			current, err := directory.Stat(".")
			if err != nil || !sameOpenCodeArtifactFile(info, current) {
				return errOpenCodeArtifacts
			}
			return nil
		}
	}
}

func readOpenCodeArtifactFile(root *os.Root, name, manifestPath string) (openCodeArtifactEntry, error) {
	var entry openCodeArtifactEntry
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || !safeOpenCodeArtifactMode(info.Mode()) || info.Size() > openCodeArtifactsMaxFileBytes {
		return entry, errOpenCodeArtifacts
	}
	// A replaced symlink cannot redirect hashing; a replaced FIFO/device cannot
	// block or be read as payload. The opened inode/type is checked before reads.
	file, err := root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return entry, errOpenCodeArtifacts
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameOpenCodeArtifactFile(info, opened) {
		return entry, errOpenCodeArtifacts
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, openCodeArtifactsMaxFileBytes+1))
	after, statErr := file.Stat()
	current, pathErr := root.Lstat(name)
	if err != nil || statErr != nil || pathErr != nil || size != info.Size() ||
		!sameOpenCodeArtifactFile(info, after) || !sameOpenCodeArtifactFile(info, current) {
		return entry, errOpenCodeArtifacts
	}
	return openCodeArtifactEntry{Path: manifestPath, Type: "file", Mode: uint32(info.Mode().Perm()),
		Size: size, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func sameOpenCodeArtifactFile(first, second os.FileInfo) bool {
	return os.SameFile(first, second) && first.Mode() == second.Mode() && first.Size() == second.Size() &&
		first.ModTime().Equal(second.ModTime())
}

func safeOpenCodeArtifactMode(mode os.FileMode) bool {
	if !mode.IsRegular() && !mode.IsDir() {
		return false
	}
	if mode&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 || mode.Perm()&0022 != 0 || mode.Perm()&0400 == 0 {
		return false
	}
	return !mode.IsDir() || mode.Perm()&0100 != 0
}

func validOpenCodeArtifactPath(name string) bool {
	return name != "." && len(name) <= 4096 && strings.Count(name, "/") <= 256 && fs.ValidPath(name) && utf8.ValidString(name) &&
		!strings.Contains(name, "\\") && strings.IndexFunc(name, unicode.IsControl) < 0
}

func validOpenCodeArtifactDigest(digest string) bool {
	if len(digest) != 64 {
		return false
	}
	for _, char := range digest {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

func safeOpenCodeArtifactLink(name, target string) bool {
	if !strings.HasPrefix(name, "server/") || target == "" || len(target) > 4096 ||
		path.IsAbs(target) || !utf8.ValidString(target) || strings.Contains(target, "\\") ||
		strings.IndexFunc(target, unicode.IsControl) >= 0 {
		return false
	}
	resolved := path.Clean(path.Join(path.Dir(name), target))
	return resolved == "server" || strings.HasPrefix(resolved, "server/")
}

func parseOpenCodeArtifactsManifest(content []byte) (openCodeArtifactsManifest, error) {
	var manifest openCodeArtifactsManifest
	if len(content) == 0 || len(content) > OpenCodeArtifactsManifestMaxBytes {
		return manifest, errOpenCodeArtifacts
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || manifest.Version != 1 {
		return manifest, errOpenCodeArtifacts
	}
	canonical, err := json.Marshal(manifest)
	if err != nil || !bytes.Equal(bytes.TrimSpace(content), canonical) {
		// Also refuses duplicate JSON object keys, trailing values and alternate
		// encodings; only surrounding transport whitespace is immaterial.
		return manifest, errOpenCodeArtifacts
	}
	if !validOpenCodeArtifactDigest(manifest.Server.SHA256) || manifest.Server.Count < 3 ||
		manifest.Server.Count > openCodeArtifactsMaxEntries || manifest.Server.Size <= 0 ||
		manifest.Server.Size > openCodeArtifactsMaxPayloadBytes {
		return manifest, errOpenCodeArtifacts
	}
	size := manifest.Server.Size
	for _, binary := range []openCodeArtifactBinary{manifest.Glibc, manifest.Musl} {
		if !validOpenCodeArtifactDigest(binary.SHA256) || binary.Size <= 0 || binary.Size > openCodeArtifactsMaxFileBytes ||
			binary.Size > openCodeArtifactsMaxPayloadBytes-size || binary.Mode > 0777 || binary.Mode&0111 != 0111 ||
			!safeOpenCodeArtifactMode(os.FileMode(binary.Mode)) {
			return manifest, errOpenCodeArtifacts
		}
		size += binary.Size
	}
	return manifest, nil
}
