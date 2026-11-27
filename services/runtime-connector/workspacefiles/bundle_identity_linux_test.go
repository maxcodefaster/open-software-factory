package workspacefiles

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type identityArchiveEntry struct {
	h    tar.Header
	body []byte
}

func identityXattr(name string, value []byte) (string, string) {
	return "FACTORY.xattr." + base64.RawURLEncoding.EncodeToString([]byte(name)), base64.StdEncoding.EncodeToString(value)
}

func identityFixture() []identityArchiveEntry {
	entries := []identityArchiveEntry{
		{h: tar.Header{Name: ".", Typeflag: tar.TypeDir, Mode: 0755}},
		{h: tar.Header{Name: ".git", Typeflag: tar.TypeDir, Mode: 0755}},
		{h: tar.Header{Name: ".git/objects", Typeflag: tar.TypeDir, Mode: 0755}},
		{h: tar.Header{Name: ".git/objects/history", Typeflag: tar.TypeReg, Mode: 0644}, body: []byte("retained committed history\n")},
		{h: tar.Header{Name: ".git/HEAD", Typeflag: tar.TypeReg, Mode: 0644}, body: []byte("ref: refs/heads/main\n")},
		{h: tar.Header{Name: "saved", Typeflag: tar.TypeReg, Mode: 0640}, body: []byte{0, 1, 255, 10}},
		{h: tar.Header{Name: "saved-alias", Typeflag: tar.TypeLink, Linkname: "saved", Mode: 0640}},
		{h: tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "saved", Mode: 0777}},
		{h: tar.Header{Name: "nested", Typeflag: tar.TypeDir, Mode: 0750}},
		{h: tar.Header{Name: "nested/leaf", Typeflag: tar.TypeReg, Mode: 0600}, body: []byte("saved leaf\n")},
		{h: tar.Header{Name: "twin", Typeflag: tar.TypeReg, Mode: 0640}, body: []byte{0, 1, 255, 10}},
	}
	stamp := time.Unix(1_790_000_000, 123456789)
	for i := range entries {
		h := &entries[i].h
		h.Uid, h.Gid, h.Format = 1000, 1000, tar.FormatPAX
		h.ModTime, h.AccessTime = stamp, stamp.Add(-123*time.Nanosecond)
		if h.Name == "saved" || h.Name == "saved-alias" || h.Name == "twin" {
			key, value := identityXattr("user.factory", []byte{0, 10, 255})
			empty, _ := identityXattr("user.empty", nil)
			h.PAXRecords = map[string]string{key: value, empty: ""}
		}
	}
	return entries
}

func identityEntry(t *testing.T, entries []identityArchiveEntry, name string) *identityArchiveEntry {
	t.Helper()
	for i := range entries {
		if entries[i].h.Name == name {
			return &entries[i]
		}
	}
	t.Fatalf("missing owned identity fixture entry %q", name)
	return nil
}

func identityArchive(t *testing.T, entries []identityArchiveEntry) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "identity-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	writer := tar.NewWriter(file)
	for _, entry := range entries {
		h := entry.h
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(entry.body))
		}
		if err := writer.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if len(entry.body) != 0 && h.Typeflag == tar.TypeReg {
			if _, err := writer.Write(entry.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return file
}

func inspectIdentity(t *testing.T, file *os.File) Bundle {
	t.Helper()
	bundle, err := InspectBundle(file)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := hex.DecodeString(bundle.TreeSHA256)
	if err != nil || len(digest) != sha256.Size {
		t.Fatal("successful inspection omitted the cryptographic tree identity")
	}
	return bundle
}

func TestBundleIdentityExcludesOnlyAccessTimeFromRestorableMetadata(t *testing.T) {
	entries := identityFixture()
	// Cross the existing archive chunk boundary without enlarging every fixture.
	identityEntry(t, entries, "nested/leaf").body = bytes.Repeat([]byte{0, 1, 255}, SourceChunkBytes/3+37)
	firstFile := identityArchive(t, entries)
	first := inspectIdentity(t, firstFile)
	for i := range entries {
		entries[i].h.AccessTime = entries[i].h.AccessTime.Add(time.Nanosecond)
	}
	secondFile := identityArchive(t, entries)
	second := inspectIdentity(t, secondFile)
	if first.SHA256 == second.SHA256 || reflect.DeepEqual(first.Chunks, second.Chunks) {
		t.Fatal("atime-only archive change did not change the existing byte/chunk proof")
	}
	if first.TreeSHA256 != second.TreeSHA256 {
		t.Fatal("ordinary Source access time changed the saved tree identity")
	}
	if actual := inspectIdentity(t, firstFile); !reflect.DeepEqual(first, actual) {
		t.Fatal("repeated inspection changed the immutable manifest")
	}
	for _, sample := range []struct {
		file   *os.File
		bundle Bundle
	}{{firstFile, first}, {secondFile, second}} {
		data, err := os.ReadFile(sample.file.Name())
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		if sample.bundle.Version != 1 || sample.bundle.Bytes != int64(len(data)) ||
			sample.bundle.SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatal("existing archive version/size/SHA256 semantics changed")
		}
		var chunks []string
		for offset := 0; offset < len(data); offset += SourceChunkBytes {
			digest := sha256.Sum256(data[offset:min(offset+SourceChunkBytes, len(data))])
			chunks = append(chunks, hex.EncodeToString(digest[:]))
		}
		if len(chunks) < 2 || !reflect.DeepEqual(sample.bundle.Chunks, chunks) {
			t.Fatal("existing raw archive chunk boundaries or hashes changed")
		}
	}
}

func TestBundleIdentityCanonicalizesArchiveOrderAndHardlinkRepresentative(t *testing.T) {
	first := inspectIdentity(t, identityArchive(t, identityFixture()))
	entries := identityFixture()
	saved, alias := identityEntry(t, entries, "saved"), identityEntry(t, entries, "saved-alias")
	alias.h.Typeflag, alias.h.Linkname, alias.body = tar.TypeReg, "", saved.body
	saved.h.Typeflag, saved.h.Linkname, saved.body = tar.TypeLink, "saved-alias", nil
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	file := identityArchive(t, entries)
	second := inspectIdentity(t, file)
	if first.SHA256 == second.SHA256 || first.TreeSHA256 != second.TreeSHA256 {
		t.Fatal("archive encoding/order was confused with the saved hardlink tree")
	}
	for range 8 {
		if actual := inspectIdentity(t, file); !reflect.DeepEqual(second, actual) {
			t.Fatal("map iteration changed canonical identity")
		}
	}
}

func TestBundleIdentityHashesAllContentAcrossChunksWithIdenticalStatMetadata(t *testing.T) {
	entries := identityFixture()
	entry := identityEntry(t, entries, "nested/leaf")
	entry.body = bytes.Repeat([]byte{0, 1, 255}, SourceChunkBytes)
	first := inspectIdentity(t, identityArchive(t, entries))
	// No size, path, owner, mode or timestamp change: only the last byte in a
	// file larger than two chunks. Stat or prefix-only shortcuts must fail.
	entry.body[len(entry.body)-1] ^= 1
	second := inspectIdentity(t, identityArchive(t, entries))
	if first.TreeSHA256 == second.TreeSHA256 {
		t.Fatal("late changed content with identical metadata retained its tree identity")
	}
}

func TestBundleIdentityChangesForSavedTreeChanges(t *testing.T) {
	first := inspectIdentity(t, identityArchive(t, identityFixture()))
	cases := []struct {
		name   string
		change func([]identityArchiveEntry)
	}{
		{"file-bytes", func(entries []identityArchiveEntry) { identityEntry(t, entries, "saved").body[0] ^= 1 }},
		{"file-size", func(entries []identityArchiveEntry) {
			entry := identityEntry(t, entries, "saved")
			entry.body = append(entry.body, 0)
		}},
		{"git-history", func(entries []identityArchiveEntry) { identityEntry(t, entries, ".git/objects/history").body[0] ^= 1 }},
		{"git-head", func(entries []identityArchiveEntry) { identityEntry(t, entries, ".git/HEAD").body[0] ^= 1 }},
		{"path-name", func(entries []identityArchiveEntry) {
			identityEntry(t, entries, "nested/leaf").h.Name = "nested/renamed"
		}},
		{"file-type", func(entries []identityArchiveEntry) {
			entry := identityEntry(t, entries, "nested/leaf")
			entry.h.Typeflag, entry.body = tar.TypeDir, nil
		}},
		{"file-mode", func(entries []identityArchiveEntry) {
			for _, name := range []string{"saved", "saved-alias"} {
				identityEntry(t, entries, name).h.Mode = 0644
			}
		}},
		{"root-mode", func(entries []identityArchiveEntry) { entries[0].h.Mode = 0750 }},
		{"directory-mode", func(entries []identityArchiveEntry) { identityEntry(t, entries, "nested").h.Mode = 0700 }},
		{"mtime-nanosecond", func(entries []identityArchiveEntry) {
			for _, name := range []string{"saved", "saved-alias"} {
				h := &identityEntry(t, entries, name).h
				h.ModTime = h.ModTime.Add(time.Nanosecond)
			}
		}},
		{"directory-mtime-nanosecond", func(entries []identityArchiveEntry) {
			entries[0].h.ModTime = entries[0].h.ModTime.Add(time.Nanosecond)
		}},
		{"xattr-value", func(entries []identityArchiveEntry) {
			key, value := identityXattr("user.factory", []byte{0, 10, 254})
			for _, name := range []string{"saved", "saved-alias"} {
				identityEntry(t, entries, name).h.PAXRecords[key] = value
			}
		}},
		{"xattr-name", func(entries []identityArchiveEntry) {
			key, value := identityXattr("user.renamed", []byte{0, 10, 255})
			for _, name := range []string{"saved", "saved-alias"} {
				identityEntry(t, entries, name).h.PAXRecords = map[string]string{key: value}
			}
		}},
		{"xattr-removed", func(entries []identityArchiveEntry) {
			for _, name := range []string{"saved", "saved-alias"} {
				identityEntry(t, entries, name).h.PAXRecords = nil
			}
		}},
		{"empty-directory-xattr", func(entries []identityArchiveEntry) {
			key, value := identityXattr("user.empty", nil)
			entries[0].h.PAXRecords = map[string]string{key: value}
		}},
		{"symlink-target", func(entries []identityArchiveEntry) { identityEntry(t, entries, "link").h.Linkname = "twin" }},
		{"symlink-target-spelling", func(entries []identityArchiveEntry) { identityEntry(t, entries, "link").h.Linkname = "nested/../saved" }},
		{"hardlink-group", func(entries []identityArchiveEntry) { identityEntry(t, entries, "saved-alias").h.Linkname = "twin" }},
		{"hardlink-flattened", func(entries []identityArchiveEntry) {
			alias := identityEntry(t, entries, "saved-alias")
			alias.h.Typeflag, alias.h.Linkname, alias.body = tar.TypeReg, "", identityEntry(t, entries, "saved").body
		}},
	}
	for _, check := range cases {
		t.Run(check.name, func(t *testing.T) {
			entries := identityFixture()
			check.change(entries)
			current := inspectIdentity(t, identityArchive(t, entries))
			if current.TreeSHA256 == first.TreeSHA256 {
				t.Fatal("changed saved tree retained its old semantic identity")
			}
		})
	}
	removed := identityFixture()
	removed = append(removed[:9], removed[10:]...) // Remove nested/leaf, not its parent.
	if current := inspectIdentity(t, identityArchive(t, removed)); current.TreeSHA256 == first.TreeSHA256 {
		t.Fatal("removed tree entry retained its old semantic identity")
	}
}

func identityInvalidFixtures() []struct {
	name   string
	change func([]identityArchiveEntry) []identityArchiveEntry
} {
	single := func(change func(*tar.Header)) func([]identityArchiveEntry) []identityArchiveEntry {
		return func(entries []identityArchiveEntry) []identityArchiveEntry {
			change(&entries[9].h) // nested/leaf is not a hardlink.
			return entries
		}
	}
	attr := func(name string, value []byte) func(*tar.Header) {
		return func(h *tar.Header) {
			key, encoded := identityXattr(name, value)
			h.PAXRecords = map[string]string{key: encoded}
		}
	}
	return []struct {
		name   string
		change func([]identityArchiveEntry) []identityArchiveEntry
	}{
		{"escape", single(func(h *tar.Header) { h.Name = "../outside" })},
		{"absolute", single(func(h *tar.Header) { h.Name = "/outside" })},
		{"unclean", single(func(h *tar.Header) { h.Name = "nested/../leaf" })},
		{"backslash", single(func(h *tar.Header) { h.Name = "nested\\leaf" })},
		{"path-bound", single(func(h *tar.Header) { h.Name = strings.Repeat("x", 4097) })},
		{"owner", single(func(h *tar.Header) { h.Uid = 1001 })},
		{"group", single(func(h *tar.Header) { h.Gid = 1001 })},
		{"privileged-mode", single(func(h *tar.Header) { h.Mode = 04755 })},
		{"unsupported-type", single(func(h *tar.Header) { h.Typeflag = tar.TypeFifo })},
		{"missing-root", func(entries []identityArchiveEntry) []identityArchiveEntry { return entries[1:] }},
		{"duplicate", func(entries []identityArchiveEntry) []identityArchiveEntry { return append(entries, entries[9]) }},
		{"missing-parent", func(entries []identityArchiveEntry) []identityArchiveEntry {
			return append(entries[:8], entries[9:]...)
		}},
		{"symlink-parent", func(entries []identityArchiveEntry) []identityArchiveEntry {
			entries[8].h.Typeflag, entries[8].h.Linkname, entries[8].h.Mode = tar.TypeSymlink, "saved", 0777
			return entries
		}},
		{"root-not-directory", func(entries []identityArchiveEntry) []identityArchiveEntry {
			entries[0].h.Typeflag = tar.TypeReg
			return entries
		}},
		{"symlink-escape", single(func(h *tar.Header) {
			h.Typeflag, h.Linkname, h.Mode = tar.TypeSymlink, "../../outside", 0777
		})},
		{"symlink-mode", func(entries []identityArchiveEntry) []identityArchiveEntry {
			entries[7].h.Mode = 0700
			return entries
		}},
		{"hardlink-escape", single(func(h *tar.Header) { h.Typeflag, h.Linkname = tar.TypeLink, "../outside" })},
		{"hardlink-missing", single(func(h *tar.Header) { h.Typeflag, h.Linkname = tar.TypeLink, "missing" })},
		{"hardlink-not-regular", single(func(h *tar.Header) { h.Typeflag, h.Linkname = tar.TypeLink, "saved-alias" })},
		{"hardlink-mode", func(entries []identityArchiveEntry) []identityArchiveEntry {
			entries[6].h.Mode = 0600
			return entries
		}},
		{"hardlink-atime", func(entries []identityArchiveEntry) []identityArchiveEntry {
			entries[6].h.AccessTime = entries[6].h.AccessTime.Add(time.Nanosecond)
			return entries
		}},
		{"hardlink-xattrs", func(entries []identityArchiveEntry) []identityArchiveEntry {
			entries[6].h.PAXRecords = nil
			return entries
		}},
		{"xattr-namespace", single(attr("security.factory", []byte("unsupported")))},
		{"xattr-nul", single(attr("user.bad\x00name", nil))},
		{"xattr-name-alias", single(func(h *tar.Header) { h.PAXRecords = map[string]string{"FACTORY.xattr.dXNlci54eB": "AA=="} })},
		{"xattr-value-alias", single(func(h *tar.Header) {
			key, _ := identityXattr("user.factory", nil)
			h.PAXRecords = map[string]string{key: "AB=="}
		})},
		{"unknown-pax", single(func(h *tar.Header) { h.PAXRecords = map[string]string{"FACTORY.unknown": "unsupported"} })},
		{"ctime", single(func(h *tar.Header) { h.ChangeTime = h.ModTime })},
		{"mtime-overflow", single(func(h *tar.Header) { h.ModTime = time.Unix(1<<40, 0) })},
	}
}

func TestBundleIdentityInspectionRejectsUnsafeOrUnrestorableTrees(t *testing.T) {
	for _, check := range identityInvalidFixtures() {
		t.Run(check.name, func(t *testing.T) {
			file := identityArchive(t, check.change(identityFixture()))
			if bundle, err := InspectBundle(file); err == nil || bundle.TreeSHA256 != "" {
				t.Fatal("invalid tree received a semantic preservation proof")
			}
		})
	}
}

func TestBundleIdentityMaterializationKeepsValidatorRejectsBeforePublication(t *testing.T) {
	for _, check := range identityInvalidFixtures() {
		t.Run(check.name, func(t *testing.T) {
			file := identityArchive(t, check.change(identityFixture()))
			destination := filepath.Join(t.TempDir(), "project")
			if err := MaterializeBundle(file, destination); err == nil {
				t.Fatal("invalid tree was materialized")
			}
			if _, err := os.Lstat(destination); !os.IsNotExist(err) {
				t.Fatal("invalid archive created a staging checkout before validation")
			}
		})
	}
}

func TestBundleIdentityRejectsTruncatedContentAndBundleByteBounds(t *testing.T) {
	file := identityArchive(t, []identityArchiveEntry{
		{h: tar.Header{Name: ".", Typeflag: tar.TypeDir, Mode: 0755, Uid: 1000, Gid: 1000}},
		{h: tar.Header{Name: "saved", Typeflag: tar.TypeReg, Mode: 0600, Uid: 1000, Gid: 1000}, body: bytes.Repeat([]byte{1}, 2048)},
	})
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(file)
	for {
		h, err := reader.Next()
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == "saved" {
			offset, err := file.Seek(0, io.SeekCurrent)
			if err != nil {
				t.Fatal(err)
			}
			if err := file.Truncate(offset + h.Size - 1); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if bundle, err := InspectBundle(file); err == nil || bundle.TreeSHA256 != "" {
		t.Fatal("truncated file data received a tree identity")
	}
	// A sparse oversized archive is refused before reading any of its bytes.
	if err := file.Truncate(MaxSourceBundleBytes + 1); err != nil {
		t.Fatal(err)
	}
	if bundle, err := InspectBundle(file); err == nil || bundle.TreeSHA256 != "" {
		t.Fatal("oversized archive received a tree identity")
	}
	// Reject an oversized declared body without allocating or reading that body.
	var header bytes.Buffer
	writer := tar.NewWriter(&header)
	if err := writer.WriteHeader(&tar.Header{Name: "large", Typeflag: tar.TypeReg, Mode: 0600, Uid: 1000, Gid: 1000, Size: MaxSourceBundleBytes + 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectBundleTree(&header); err == nil {
		t.Fatal("oversized declared content was inspected")
	}
}

func TestBundleIdentityRejectsOversizedPAXBeforeAllocatingXattrMetadata(t *testing.T) {
	// Go's tar writer refuses oversized PAX itself. Construct a real header
	// declaring that payload, retaining the checksum, to exercise the reader
	// bound without allocating the adversarial metadata.
	var header bytes.Buffer
	writer := tar.NewWriter(&header)
	if err := writer.WriteHeader(&tar.Header{Name: "PaxHeaders/owned", Typeflag: tar.TypeReg, Mode: 0600, Size: 1<<20 + 1}); err != nil {
		t.Fatal(err)
	}
	data := header.Bytes()
	data[156] = tar.TypeXHeader
	copy(data[148:156], "        ")
	var checksum int
	for _, value := range data {
		checksum += int(value)
	}
	copy(data[148:156], fmt.Sprintf("%06o\x00 ", checksum))
	file, err := os.CreateTemp(t.TempDir(), "oversized-pax-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if bundle, err := InspectBundle(file); err == nil || bundle.TreeSHA256 != "" {
		t.Fatal("oversized PAX metadata received a tree identity")
	}
}

func TestBundleIdentityWireFieldIsOptionalButPresentOnActualInspection(t *testing.T) {
	data, err := json.Marshal(Bundle{})
	if err != nil || bytes.Contains(data, []byte(`"treeSHA256"`)) {
		t.Fatal("empty compatibility manifest should omit treeSHA256")
	}
	bundle := inspectIdentity(t, identityArchive(t, identityFixture()))
	data, err = json.Marshal(bundle)
	if err != nil || !bytes.Contains(data, []byte(`"treeSHA256":"`+bundle.TreeSHA256+`"`)) {
		t.Fatal("actual inspection omitted its optional wire proof")
	}
}

func TestBundleIdentityRepeatedExportImportSurvivesOrdinarySourceReads(t *testing.T) {
	_, source := bundleFixture(t)
	var expected string
	for round := range 3 {
		output, err := os.CreateTemp(t.TempDir(), "source-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { output.Close() })
		bundle, err := source.ExportBundle(output)
		if err != nil {
			t.Fatal(err)
		}
		if len(bundle.TreeSHA256) != sha256.Size*2 {
			t.Fatal("actual export omitted semantic identity")
		}
		if round == 0 {
			expected = bundle.TreeSHA256
		} else if bundle.TreeSHA256 != expected {
			t.Fatal("export/import or independent Source reads changed the saved tree identity")
		}
		destination := filepath.Join(t.TempDir(), "project")
		if err := MaterializeBundle(output, destination); err != nil {
			t.Fatal(err)
		}
		restored, err := Open(destination)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { restored.Close() })
		source = restored
		if _, err := source.Read("tracked"); err != nil {
			t.Fatal(err)
		}
		if _, err := source.List(""); err != nil {
			t.Fatal(err)
		}
	}
}
