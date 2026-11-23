package connector

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

func openCodeArtifactsTestRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func writeOpenCodeArtifactsTestFile(t *testing.T, root, name string, contents []byte, mode os.FileMode) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(file); err == nil && info.Mode().IsRegular() {
		if err := os.Chmod(file, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(file, contents, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, mode); err != nil {
		t.Fatal(err)
	}
}

func openCodeArtifactsTestPackage(t *testing.T) (string, []byte) {
	t.Helper()
	root := openCodeArtifactsTestRoot(t)
	files := map[string]string{
		"server/server.mjs":                                 "throw new Error('do not execute unverified server')",
		"server/input-stop.mjs":                             "export const stop = 'fixed';",
		"server/config/opencode.json":                       `{"plugins":["-opencode.config.compatibility"]}`,
		"server/config/AGENTS.md":                           "# Fixed runtime policy\n",
		"server/node_modules/pkg/package.json":              `{"name":"pkg","main":"index.js"}`,
		"server/node_modules/pkg/index.js":                  "export const module = 'fixed';",
		"server/node_modules/@native/linux/binding.node":    "\x7fELFowned-native-module",
		"server/node_modules/@opencode/server/package.json": `{"name":"@opencode/server","version":"2.3.2"}`,
		"glibc/bun": "owned-glibc-bun",
		"musl/bun":  "owned-musl-bun",
	}
	for name, content := range files {
		mode := os.FileMode(0644)
		if strings.HasSuffix(name, "/bun") {
			mode = 0555
		}
		writeOpenCodeArtifactsTestFile(t, root, name, []byte(content), mode)
	}
	if err := os.Mkdir(filepath.Join(root, "server/node_modules/.bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../pkg/index.js", filepath.Join(root, "server/node_modules/.bin/helper")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("pkg", filepath.Join(root, "server/node_modules/linked-package")); err != nil {
		t.Fatal(err)
	}
	manifest, err := OpenCodeArtifactsManifest(root)
	if err != nil {
		t.Fatal(err)
	}
	writeOpenCodeArtifactsTestFile(t, root, openCodeArtifactsManifestName, manifest, 0444)
	return root, manifest
}

func openCodeArtifactsTestInstalled(t *testing.T, source string, manifest []byte, libc string) string {
	t.Helper()
	root := openCodeArtifactsTestRoot(t)
	if _, err := parseOpenCodeArtifactsManifest(manifest); err != nil {
		t.Fatal(err)
	}
	if err := filepath.WalkDir(filepath.Join(source, "server"), func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		target := filepath.Join(root, relative)
		switch {
		case info.IsDir():
			return os.Mkdir(target, info.Mode().Perm())
		case info.Mode().IsRegular():
			content, err := os.ReadFile(name)
			if err != nil {
				return err
			}
			return os.WriteFile(target, content, info.Mode().Perm())
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(name)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		default:
			return errOpenCodeArtifacts
		}
	}); err != nil {
		t.Fatal(err)
	}
	bun, err := os.ReadFile(filepath.Join(source, libc, "bun"))
	if err != nil {
		t.Fatal(err)
	}
	writeOpenCodeArtifactsTestFile(t, root, "bun", bun, 0555)
	return root
}

func TestOpenCodeArtifactsManifestIsCompleteCanonicalAndDeterministic(t *testing.T) {
	first, manifest := openCodeArtifactsTestPackage(t)
	second, another := openCodeArtifactsTestPackage(t)
	if !bytes.Equal(manifest, another) {
		t.Fatal("different creation order or temporary root changed the manifest")
	}
	// Filesystem inode/directory sizes and timestamps are not portable identity.
	if err := filepath.WalkDir(second, func(name string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return os.Chtimes(name, time.Unix(1, 0), time.Unix(1, 0))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	another, err := OpenCodeArtifactsManifest(second)
	if err != nil || !bytes.Equal(manifest, another) {
		t.Fatal("timestamp metadata entered the manifest", err)
	}
	var parsed openCodeArtifactsManifest
	if err := json.Unmarshal(manifest, &parsed); err != nil || parsed.Version != 1 {
		t.Fatal("invalid manifest version", err)
	}
	if len(manifest) >= 4096 || bytes.Contains(manifest, []byte(`"entries"`)) ||
		!validOpenCodeArtifactDigest(parsed.Server.SHA256) || parsed.Server.Count < 3 ||
		parsed.Glibc.SHA256 == parsed.Musl.SHA256 {
		t.Fatal("manifest omitted the compact complete tree or variant identity")
	}
	total, err := OpenCodeArtifactsSize(manifest)
	if err != nil || total != parsed.Server.Size+parsed.Glibc.Size+parsed.Musl.Size {
		t.Fatal("safe payload size differs", total, err)
	}
	for _, name := range []string{"manifest.json", ".git/factory-opencode.db", "admitted-skills/private", "sessions/private", "environment.json"} {
		writeOpenCodeArtifactsTestFile(t, first, name, []byte("private-not-payload"), 0600)
	}
	current, err := OpenCodeArtifactsManifest(first)
	if err != nil || !bytes.Equal(current, manifest) || bytes.Contains(current, []byte("private-not-payload")) {
		t.Fatal("manifest included private sibling data or its own file", err)
	}
	writeOpenCodeArtifactsTestFile(t, second, "server/input-stop.mjs", []byte("changed final addition"), 0644)
	current, err = OpenCodeArtifactsManifest(second)
	if err != nil || bytes.Equal(current, manifest) {
		t.Fatal("changed final server addition retained the earlier identity", err)
	}
}

func TestOpenCodeArtifactsVerifySelectsOnlyTheExpectedInstalledVariant(t *testing.T) {
	source, manifest := openCodeArtifactsTestPackage(t)
	for _, libc := range []string{"musl", "glibc"} {
		t.Run(libc, func(t *testing.T) {
			root := openCodeArtifactsTestInstalled(t, source, manifest, libc)
			// No installed marker, label or spare variant can establish readiness.
			writeOpenCodeArtifactsTestFile(t, root, "manifest.json", []byte("forged marker"), 0666)
			writeOpenCodeArtifactsTestFile(t, root, "glibc/bun", []byte("untrusted spare variant"), 0644)
			writeOpenCodeArtifactsTestFile(t, root, "musl/bun", []byte("untrusted spare variant"), 0644)
			if err := VerifyOpenCodeArtifacts(root, manifest, libc); err != nil {
				t.Fatal(err)
			}
			other := "glibc"
			if libc == other {
				other = "musl"
			}
			if err := VerifyOpenCodeArtifacts(root, manifest, other); err == nil {
				t.Fatal("wrong libc selected the installed binary")
			}
			for _, invalid := range []string{"", "amd64", "GLIBC", "../musl"} {
				if err := VerifyOpenCodeArtifacts(root, manifest, invalid); err == nil {
					t.Fatal("unknown variant was accepted")
				}
			}
		})
	}
}

func TestOpenCodeArtifactsCompactIdentityBindsContentsPathsModesAndLinkTargets(t *testing.T) {
	for _, scenario := range []string{"native-module", "input-stop", "rename", "directory-mode", "link-target", "bun"} {
		t.Run(scenario, func(t *testing.T) {
			root, before := openCodeArtifactsTestPackage(t)
			if scenario == "link-target" {
				content, err := os.ReadFile(filepath.Join(root, "server/node_modules/pkg/index.js"))
				if err != nil {
					t.Fatal(err)
				}
				writeOpenCodeArtifactsTestFile(t, root, "server/node_modules/pkg/other.js", content, 0644)
				before, err = OpenCodeArtifactsManifest(root)
				if err != nil {
					t.Fatal(err)
				}
			}
			switch scenario {
			case "native-module", "input-stop", "bun":
				name := "server/node_modules/@native/linux/binding.node"
				mode := os.FileMode(0644)
				if scenario == "input-stop" {
					name = "server/input-stop.mjs"
				} else if scenario == "bun" {
					name, mode = "musl/bun", 0555
				}
				content, err := os.ReadFile(filepath.Join(root, name))
				if err != nil {
					t.Fatal(err)
				}
				content[0] ^= 1
				writeOpenCodeArtifactsTestFile(t, root, name, content, mode)
			case "rename":
				name := filepath.Join(root, "server/node_modules/@native/linux/binding.node")
				if err := os.Rename(name, name+".renamed"); err != nil {
					t.Fatal(err)
				}
			case "directory-mode":
				name := filepath.Join(root, "server/config")
				if err := os.Chmod(name, 0555); err != nil {
					t.Fatal(err)
				}
				defer os.Chmod(name, 0755)
			case "link-target":
				name := filepath.Join(root, "server/node_modules/.bin/helper")
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("../pkg/other.js", name); err != nil {
					t.Fatal(err)
				}
			}
			after, err := OpenCodeArtifactsManifest(root)
			if err != nil || bytes.Equal(before, after) {
				t.Fatal("changed complete payload retained its compact identity", err)
			}
			first, _ := parseOpenCodeArtifactsManifest(before)
			second, _ := parseOpenCodeArtifactsManifest(after)
			if first.Server.Count != second.Server.Count || first.Server.Size != second.Server.Size {
				t.Fatal("fixture must prove fingerprint changes even with equal count/bytes")
			}
			if scenario == "bun" && first.Server != second.Server {
				t.Fatal("Bun content unexpectedly changed the independent server fingerprint")
			}
		})
	}
}

func TestOpenCodeArtifactsVerifyRejectsChangedMissingExtraAndUnsafePayload(t *testing.T) {
	source, manifest := openCodeArtifactsTestPackage(t)
	for _, scenario := range []string{
		"native-module", "bun", "input-stop", "missing-file", "missing-directory", "extra-file",
		"extra-directory", "changed-mode", "writable-file", "writable-directory", "absolute-link",
		"escaping-link", "dangling-link", "changed-relative-link", "server-symlink", "bun-symlink",
	} {
		t.Run(scenario, func(t *testing.T) {
			root := openCodeArtifactsTestInstalled(t, source, manifest, "musl")
			module := filepath.Join(root, "server/node_modules/@native/linux/binding.node")
			outside := filepath.Join(openCodeArtifactsTestRoot(t), "private-outside-file")
			if err := os.WriteFile(outside, []byte("private-outside-content"), 0644); err != nil {
				t.Fatal(err)
			}
			changeLink := func(name, target string) {
				t.Helper()
				if err := os.Remove(filepath.Join(root, name)); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
					t.Fatal(err)
				}
			}
			switch scenario {
			case "native-module":
				writeOpenCodeArtifactsTestFile(t, root, "server/node_modules/@native/linux/binding.node", []byte("\x7fELFother-native-module"), 0644)
			case "bun":
				writeOpenCodeArtifactsTestFile(t, root, "bun", []byte("other-musl-bun"), 0555)
			case "input-stop":
				writeOpenCodeArtifactsTestFile(t, root, "server/input-stop.mjs", []byte("changed input Stop"), 0644)
			case "missing-file":
				if err := os.Remove(module); err != nil {
					t.Fatal(err)
				}
			case "missing-directory":
				if err := os.RemoveAll(filepath.Join(root, "server/config")); err != nil {
					t.Fatal(err)
				}
			case "extra-file":
				writeOpenCodeArtifactsTestFile(t, root, "server/node_modules/extra.node", []byte("extra"), 0644)
			case "extra-directory":
				if err := os.Mkdir(filepath.Join(root, "server/extra"), 0755); err != nil {
					t.Fatal(err)
				}
			case "changed-mode", "writable-file":
				mode := os.FileMode(0444)
				if scenario == "writable-file" {
					mode = 0666
				}
				if err := os.Chmod(module, mode); err != nil {
					t.Fatal(err)
				}
			case "writable-directory":
				if err := os.Chmod(filepath.Join(root, "server/node_modules"), 0777); err != nil {
					t.Fatal(err)
				}
			case "absolute-link":
				changeLink("server/node_modules/.bin/helper", outside)
			case "escaping-link":
				changeLink("server/node_modules/.bin/helper", "../../../../manifest.json")
			case "dangling-link":
				changeLink("server/node_modules/.bin/helper", "../pkg/missing")
			case "changed-relative-link":
				changeLink("server/node_modules/.bin/helper", "../pkg/package.json")
			case "server-symlink":
				if err := os.RemoveAll(filepath.Join(root, "server")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(source, "server"), filepath.Join(root, "server")); err != nil {
					t.Fatal(err)
				}
			case "bun-symlink":
				changeLink("bun", filepath.Join(source, "musl/bun"))
			}
			// Replacing the copied marker cannot hide changed files.
			writeOpenCodeArtifactsTestFile(t, root, "manifest.json", manifest, 0644)
			err := VerifyOpenCodeArtifacts(root, manifest, "musl")
			if err == nil || strings.Contains(err.Error(), outside) || strings.Contains(err.Error(), "private-outside") {
				t.Fatalf("unsafe payload was accepted or diagnostics disclosed paths/content: %v", err)
			}
		})
	}
}

func TestOpenCodeArtifactsManifestRejectsUnsafeSourceTrees(t *testing.T) {
	for _, scenario := range []string{"missing-input-stop", "empty-bun", "writable", "setuid", "fifo", "large-file", "extra-variant-file", "absolute-link", "indirect-escape", "bun-symlink", "root-symlink", "ancestor-symlink"} {
		t.Run(scenario, func(t *testing.T) {
			root, _ := openCodeArtifactsTestPackage(t)
			module := filepath.Join(root, "server/node_modules/@native/linux/binding.node")
			switch scenario {
			case "missing-input-stop":
				if err := os.Remove(filepath.Join(root, "server/input-stop.mjs")); err != nil {
					t.Fatal(err)
				}
			case "empty-bun":
				writeOpenCodeArtifactsTestFile(t, root, "musl/bun", nil, 0555)
			case "writable":
				if err := os.Chmod(module, 0664); err != nil {
					t.Fatal(err)
				}
			case "setuid":
				if err := os.Chmod(module, os.ModeSetuid|0755); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := unix.Mkfifo(filepath.Join(root, "server/pipe"), 0600); err != nil {
					t.Fatal(err)
				}
			case "large-file":
				if err := os.Truncate(module, openCodeArtifactsMaxFileBytes+1); err != nil {
					t.Fatal(err)
				}
			case "extra-variant-file":
				writeOpenCodeArtifactsTestFile(t, root, "glibc/private-data", []byte("not binary payload"), 0600)
			case "absolute-link":
				if err := os.Symlink(filepath.Join(root, "server/server.mjs"), filepath.Join(root, "server/absolute")); err != nil {
					t.Fatal(err)
				}
			case "indirect-escape":
				if err := os.Symlink("../../manifest.json", filepath.Join(root, "server/node_modules/outside")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("node_modules/outside", filepath.Join(root, "server/indirect")); err != nil {
					t.Fatal(err)
				}
			case "bun-symlink":
				if err := os.Remove(filepath.Join(root, "glibc/bun")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("../musl/bun", filepath.Join(root, "glibc/bun")); err != nil {
					t.Fatal(err)
				}
			case "root-symlink":
				link := filepath.Join(openCodeArtifactsTestRoot(t), "alias")
				if err := os.Symlink(root, link); err != nil {
					t.Fatal(err)
				}
				root = link
			case "ancestor-symlink":
				link := filepath.Join(openCodeArtifactsTestRoot(t), "ancestor")
				if err := os.Symlink(filepath.Dir(root), link); err != nil {
					t.Fatal(err)
				}
				root = filepath.Join(link, filepath.Base(root))
			}
			if _, err := OpenCodeArtifactsManifest(root); err == nil {
				t.Fatal("unsafe source tree entered the reusable manifest")
			}
		})
	}
}

func TestOpenCodeArtifactsExpectedManifestRejectsMalformedAndUnboundedInputs(t *testing.T) {
	source, manifest := openCodeArtifactsTestPackage(t)
	root := openCodeArtifactsTestInstalled(t, source, manifest, "musl")
	for _, scenario := range []string{"version", "negative-size", "large-size", "total-size", "unsafe-mode", "invalid-sha", "invalid-count", "too-many-entries", "empty-tree", "missing-bun", "unknown-field", "duplicate-key", "trailing-json", "too-large", "legacy-entries"} {
		t.Run(scenario, func(t *testing.T) {
			var parsed openCodeArtifactsManifest
			if err := json.Unmarshal(manifest, &parsed); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "version":
				parsed.Version++
			case "negative-size", "large-size":
				size := int64(-1)
				if scenario == "large-size" {
					size = openCodeArtifactsMaxFileBytes + 1
				}
				parsed.Musl.Size = size
			case "total-size":
				parsed.Server.Size = openCodeArtifactsMaxPayloadBytes
			case "unsafe-mode":
				parsed.Musl.Mode = 04755
			case "invalid-sha":
				parsed.Server.SHA256 = strings.Repeat("A", 64)
			case "invalid-count":
				parsed.Server.Count = -1
			case "too-many-entries":
				parsed.Server.Count = openCodeArtifactsMaxEntries + 1
			case "empty-tree":
				parsed.Server.Size = 0
			case "missing-bun":
				parsed.Glibc = openCodeArtifactBinary{}
			}
			content, err := json.Marshal(parsed)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "unknown-field":
				content = bytes.Replace(content, []byte(`{"version":1,`), []byte(`{"private":"not-allowed","version":1,`), 1)
			case "duplicate-key":
				content = bytes.Replace(content, []byte(`{"version":1,`), []byte(`{"version":0,"version":1,`), 1)
			case "trailing-json":
				content = append(content, []byte(`{}`)...)
			case "too-large":
				content = bytes.Repeat([]byte(" "), OpenCodeArtifactsManifestMaxBytes+1)
			case "legacy-entries":
				content = []byte(`{"version":1,"entries":[]}`)
			}
			if err := VerifyOpenCodeArtifacts(root, content, "musl"); err == nil {
				t.Fatal("malformed expected manifest was accepted")
			}
			if _, err := OpenCodeArtifactsSize(content); err == nil {
				t.Fatal("malformed manifest established a safe copy size")
			}
		})
	}
}

func TestOpenCodeArtifactsInternalTreeHashIsSortedAndRejectsDuplicatePaths(t *testing.T) {
	root, _ := openCodeArtifactsTestPackage(t)
	directory, err := openOpenCodeArtifactsRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	var scan openCodeArtifactScan
	if err := scan.server(directory); err != nil {
		t.Fatal(err)
	}
	first, err := scan.fingerprint()
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(scan.entries, func(i, j int) bool { return scan.entries[i].Path > scan.entries[j].Path })
	second, err := scan.fingerprint()
	if err != nil || first != second {
		t.Fatal("filesystem enumeration order changed the canonical tree digest", err)
	}
	scan.entries = append(scan.entries, scan.entries[0])
	if _, err := scan.fingerprint(); err == nil {
		t.Fatal("duplicate tree membership was accepted")
	}
}

// Explicit local-export measurement only; no Actor, image build or payload
// execution. An owned hardlink supplies installed /bun without copying 600 MB.
func BenchmarkOpenCodeArtifactsQualifiedExport(b *testing.B) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		b.Fatal("source location is unavailable")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.factory/test-results/agent-preview-readiness-20261123/packaged-tools-complete"))
	if _, err := os.Stat(root); os.IsNotExist(err) {
		b.Skip("requires the explicitly exported qualified ARM package")
	}
	var manifest []byte
	var err error
	b.ResetTimer()
	started := time.Now()
	for i := 0; i < b.N; i++ {
		manifest, err = OpenCodeArtifactsManifest(root)
		if err != nil {
			b.Fatal(err)
		}
	}
	creation := time.Since(started)
	b.StopTimer()
	parsed, err := parseOpenCodeArtifactsManifest(manifest)
	if err != nil {
		b.Fatal(err)
	}
	size, err := OpenCodeArtifactsSize(manifest)
	if err != nil || len(manifest) >= 4096 {
		b.Fatal("compact package manifest is invalid", err)
	}
	b.ReportMetric(float64(len(manifest)), "manifest-bytes")
	b.ReportMetric(float64(size), "payload-bytes")
	b.ReportMetric(float64(parsed.Server.Count), "server-entries")
	b.ReportMetric(float64(creation.Milliseconds())/float64(b.N), "creation-ms")
	installed := filepath.Join(root, "bun")
	for _, libc := range []string{"musl", "glibc"} {
		original, err := os.Stat(filepath.Join(root, libc, "bun"))
		if err != nil {
			b.Fatal(err)
		}
		if err := os.Link(filepath.Join(root, libc, "bun"), installed); err != nil {
			b.Fatal("cannot replace a pre-existing exported-package /bun", err)
		}
		started := time.Now()
		verifyErr := VerifyOpenCodeArtifacts(root, manifest, libc)
		elapsed := time.Since(started)
		current, statErr := os.Lstat(installed)
		if statErr != nil || !os.SameFile(original, current) {
			b.Fatal("owned measurement link identity changed; retained")
		}
		if err := os.Remove(installed); err != nil {
			b.Fatal(err)
		}
		if verifyErr != nil {
			b.Fatal(verifyErr)
		}
		b.ReportMetric(float64(elapsed.Milliseconds()), libc+"-verify-ms")
	}
	b.Logf("compact manifest: %s; host hashing of real ARM files, not native execution or copy-speed qualification", manifest)
}

func TestReadOpenCodeArtifactsManifestReturnsCanonicalPublicDigest(t *testing.T) {
	root, manifest := openCodeArtifactsTestPackage(t)
	writeOpenCodeArtifactsTestFile(t, root, openCodeArtifactsManifestName, append(append([]byte(nil), manifest...), '\n'), 0444)
	content, digest, err := ReadOpenCodeArtifactsManifest(root)
	sum := sha256.Sum256(manifest)
	if err != nil || !bytes.Equal(content, manifest) || digest != hex.EncodeToString(sum[:]) {
		t.Fatal("shipped manifest bytes/digest were not canonical", digest, err)
	}
	for _, scenario := range []string{"writable", "symlink", "oversized", "malformed", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			root, manifest := openCodeArtifactsTestPackage(t)
			name := filepath.Join(root, openCodeArtifactsManifestName)
			switch scenario {
			case "writable":
				if err := os.Chmod(name, 0666); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Rename(name, name+".other"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("manifest.json.other", name); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				if err := os.Chmod(name, 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Truncate(name, OpenCodeArtifactsManifestMaxBytes+1); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				writeOpenCodeArtifactsTestFile(t, root, openCodeArtifactsManifestName, append(manifest, []byte("{}")...), 0444)
			case "missing":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			}
			content, digest, err := ReadOpenCodeArtifactsManifest(root)
			if err == nil || content != nil || digest != "" {
				t.Fatal("unavailable manifest established an identity", digest, err)
			}
		})
	}
}

func TestResetOpenCodeArtifactsRemovesOnlyOwnedPayloadWithoutFollowingLinks(t *testing.T) {
	source, manifest := openCodeArtifactsTestPackage(t)
	root := openCodeArtifactsTestInstalled(t, source, manifest, "musl")
	untouched := []string{".git/factory-opencode.db", "admitted-skills/skill.md", "sessions/session.db",
		"manifest.json", "glibc/bun", "musl/bun", "environment.json"}
	for _, name := range untouched {
		writeOpenCodeArtifactsTestFile(t, root, name, []byte("retained private sibling"), 0600)
	}
	outside := openCodeArtifactsTestRoot(t)
	writeOpenCodeArtifactsTestFile(t, outside, "session.db", []byte("retained outside target"), 0600)
	if err := os.Symlink(outside, filepath.Join(root, "server/outside")); err != nil {
		t.Fatal(err)
	}
	if err := ResetOpenCodeArtifacts(root); err != nil {
		t.Fatal(err)
	}
	if err := ResetOpenCodeArtifacts(root); err != nil {
		t.Fatal("reset is not idempotent", err)
	}
	for _, name := range []string{"server", "bun"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatal("reset retained installed payload", name, err)
		}
	}
	for _, name := range untouched {
		content, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(content) != "retained private sibling" {
			t.Fatal("reset touched non-payload data", name, err)
		}
	}
	content, err := os.ReadFile(filepath.Join(outside, "session.db"))
	if err != nil || string(content) != "retained outside target" {
		t.Fatal("reset followed a payload symlink", err)
	}
	// A damaged top-level payload symlink can be safely unlinked for repair.
	if err := os.Symlink(outside, filepath.Join(root, "server")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "session.db"), filepath.Join(root, "bun")); err != nil {
		t.Fatal(err)
	}
	if err := ResetOpenCodeArtifacts(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "session.db")); err != nil {
		t.Fatal("reset followed a top-level payload symlink", err)
	}
}

func TestResetOpenCodeArtifactsRefusesRedirectedRootsAndWrongPayloadShapes(t *testing.T) {
	for _, scenario := range []string{"root-symlink", "ancestor-symlink", "writable-root", "bun-directory", "server-file"} {
		t.Run(scenario, func(t *testing.T) {
			source, manifest := openCodeArtifactsTestPackage(t)
			original := openCodeArtifactsTestInstalled(t, source, manifest, "musl")
			root := original
			switch scenario {
			case "root-symlink":
				root = filepath.Join(openCodeArtifactsTestRoot(t), "alias")
				if err := os.Symlink(original, root); err != nil {
					t.Fatal(err)
				}
			case "ancestor-symlink":
				link := filepath.Join(openCodeArtifactsTestRoot(t), "ancestor")
				if err := os.Symlink(filepath.Dir(original), link); err != nil {
					t.Fatal(err)
				}
				root = filepath.Join(link, filepath.Base(original))
			case "writable-root":
				if err := os.Chmod(original, 0777); err != nil {
					t.Fatal(err)
				}
			case "bun-directory":
				if err := os.Remove(filepath.Join(original, "bun")); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(original, "bun"), 0755); err != nil {
					t.Fatal(err)
				}
			case "server-file":
				if err := os.RemoveAll(filepath.Join(original, "server")); err != nil {
					t.Fatal(err)
				}
				writeOpenCodeArtifactsTestFile(t, original, "server", []byte("not a server tree"), 0644)
			}
			if err := ResetOpenCodeArtifacts(root); err == nil {
				t.Fatal("unsafe reset was admitted")
			}
			if _, err := os.Lstat(filepath.Join(original, "server")); err != nil {
				t.Fatal("refused reset already changed the original payload", err)
			}
		})
	}
	for _, root := range []string{"/", ".", "../opencode", ""} {
		if err := ResetOpenCodeArtifacts(root); err == nil {
			t.Fatal("unbounded root was accepted")
		}
	}
}

func TestResetOpenCodeArtifactsAllowsAnAbsentFirstBootPayloadButNotRedirectedAncestors(t *testing.T) {
	root := openCodeArtifactsTestRoot(t)
	missing := filepath.Join(root, "missing", "opencode")
	if err := ResetOpenCodeArtifacts(missing); err != nil {
		t.Fatal("first-boot reset refused an absent payload", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "missing")); !os.IsNotExist(err) {
		t.Fatal("reset created a tool directory instead of leaving setup to Parent", err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	if err := ResetOpenCodeArtifacts(filepath.Join(alias, "missing")); err == nil {
		t.Fatal("an absent leaf hid a redirected ancestor")
	}
}
