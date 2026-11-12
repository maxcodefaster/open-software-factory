package workspacefiles

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func ownBundleTree(t *testing.T, root string) {
	t.Helper()
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		t.Skip("Source mapping qualification requires UID 1000 or owned root fixture")
	}
	if err := filepath.WalkDir(root, func(p string, _ os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		return os.Lchown(p, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}
}
func bundleFixture(t *testing.T) (string, *Source) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-b", "main", root}, {"-C", root, "config", "factory.repositoryIdentity", "owned-project"}, {"-C", root, "config", "user.name", "Owned"}, {"-C", root, "config", "user.email", "owned@example.invalid"}} {
		if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("owned Git setup: %v %s", err, output)
		}
	}
	for name, body := range map[string]string{"tracked": "base\n", ".gitignore": "private\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"-C", root, "add", "."}, {"-C", root, "commit", "-m", "owned"}} {
		if _, err := exec.Command("git", args...).Output(); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "tracked"), []byte("staged\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.Command("git", "-C", root, "add", "tracked").Output(); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"tracked": "dirty\n", "untracked": "untracked\n", "private": "private content never logged\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Link(filepath.Join(root, "private"), filepath.Join(root, "internal-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("tracked", filepath.Join(root, "relative-link")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lsetxattr(filepath.Join(root, "tracked"), "user.factory", []byte{0, 1, 255, 10}, 0); err != nil {
		t.Fatal(err)
	}
	ns := time.Unix(1_790_000_000, 123456789)
	if err := unix.UtimesNanoAt(unix.AT_FDCWD, filepath.Join(root, "tracked"), []unix.Timespec{unix.NsecToTimespec(ns.UnixNano() - 123), unix.NsecToTimespec(ns.UnixNano())}, 0); err != nil {
		t.Fatal(err)
	}
	ownBundleTree(t, root)
	source, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { source.Close() })
	return root, source
}

func TestSourceBundlePreservesDirtyGitLinksXattrsAndExactNanoseconds(t *testing.T) {
	root, source := bundleFixture(t)
	archive, err := os.CreateTemp(t.TempDir(), "source-")
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	first, err := source.ExportBundle(archive)
	if err != nil {
		t.Fatal(err)
	}
	secondFile, _ := os.CreateTemp(t.TempDir(), "source-")
	defer secondFile.Close()
	second, err := source.ExportBundle(secondFile)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("frozen retry changed immutable bundle: %v", err)
	}
	restored := filepath.Join(t.TempDir(), "project")
	if err := MaterializeBundle(archive, restored); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tracked", "untracked", "private", ".git/index", ".git/HEAD", ".git/refs/heads/main", ".git/config"} {
		a, e := os.ReadFile(filepath.Join(root, name))
		b, f := os.ReadFile(filepath.Join(restored, name))
		if e != nil || f != nil || !bytes.Equal(a, b) {
			t.Fatalf("Source bytes differ for retained fixture entry %s", name)
		}
	}
	var a, b unix.Stat_t
	unix.Stat(filepath.Join(root, "tracked"), &a)
	unix.Stat(filepath.Join(restored, "tracked"), &b)
	if a.Mtim != b.Mtim || a.Mode != b.Mode || a.Uid != b.Uid || a.Gid != b.Gid {
		t.Fatal("Source nanosecond/mode/owner fidelity changed")
	}
	x := make([]byte, 16)
	n, err := unix.Lgetxattr(filepath.Join(restored, "tracked"), "user.factory", x)
	if err != nil || !bytes.Equal(x[:n], []byte{0, 1, 255, 10}) {
		t.Fatal("binary xattr changed")
	}
	var link unix.Stat_t
	unix.Stat(filepath.Join(restored, "private"), &b)
	unix.Stat(filepath.Join(restored, "internal-link"), &link)
	if b.Ino != link.Ino || b.Nlink != 2 {
		t.Fatal("internal hardlinks were flattened")
	}
	if target, err := os.Readlink(filepath.Join(restored, "relative-link")); err != nil || target != "tracked" {
		t.Fatal("relative symlink changed")
	}
	git := func(directory string) []byte {
		output, err := exec.Command("git", "-c", "safe.directory="+directory, "-C", directory, "status", "--porcelain=v1").Output()
		if err != nil {
			t.Fatal(err)
		}
		return output
	}
	if !bytes.Equal(git(root), git(restored)) {
		t.Fatal("staged/unstaged/untracked Git state changed")
	}
}

func TestSourceBundleRejectsEscapesAndUnsupportedOwnershipWithoutDroppingData(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "foreign-owner", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			root, source := bundleFixture(t)
			outside := filepath.Join(t.TempDir(), "outside")
			os.WriteFile(outside, []byte("private"), 0600)
			switch kind {
			case "symlink":
				os.Symlink(outside, filepath.Join(root, "escape"))
			case "hardlink":
				os.Link(outside, filepath.Join(root, "escape"))
			case "foreign-owner":
				if os.Geteuid() != 0 {
					t.Skip("owned root fixture required")
				}
				os.Chown(filepath.Join(root, "tracked"), 1234, 1234)
			case "fifo":
				if err := unix.Mkfifo(filepath.Join(root, "fifo"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			archive, _ := os.CreateTemp(t.TempDir(), "source-")
			defer archive.Close()
			if _, err := source.ExportBundle(archive); err == nil {
				t.Fatal("unsafe/incomplete Source was accepted")
			}
			if data, err := os.ReadFile(outside); err != nil || !bytes.Equal(data, []byte("private")) {
				t.Fatal("denied export altered old data")
			}
		})
	}
}

func TestSourceMaterializeRejectsMaliciousArchiveBeforePublication(t *testing.T) {
	for _, name := range []string{"../outside", "/outside", "a/../../outside", "bad\\path"} {
		t.Run(name, func(t *testing.T) {
			file, _ := os.CreateTemp(t.TempDir(), "archive-")
			defer file.Close()
			writer := tar.NewWriter(file)
			writer.WriteHeader(&tar.Header{Name: ".", Typeflag: tar.TypeDir, Mode: 0755, Uid: 1000, Gid: 1000})
			writer.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Uid: 1000, Gid: 1000, Size: 1})
			writer.Write([]byte("x"))
			writer.Close()
			destination := filepath.Join(t.TempDir(), "project")
			if MaterializeBundle(file, destination) == nil {
				t.Fatal("malicious archive accepted")
			}
			if _, err := os.Lstat(destination); !os.IsNotExist(err) {
				t.Fatal("invalid archive published any Source")
			}
		})
	}
}

func TestSourceCheckpointProtocolFreezesDrainsAndRecoversLostReply(t *testing.T) {
	root, source := bundleFixture(t)
	access := Access{WorkspaceID: "owned-workspace", ServiceID: "owned-source", Epoch: 1, Token: strings.Repeat("a", 32), WriterEpoch: 1}
	service, err := NewService(source, access)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Revoke()
	call := func(operation string, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/workspaces/owned-workspace/"+operation, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+access.Token)
		r.Header.Set("X-Factory-Source-Service", access.ServiceID)
		r.Header.Set("X-Factory-Source-Epoch", "1")
		r.Header.Set("X-Factory-Writer-Epoch", "1")
		w := httptest.NewRecorder()
		service.ServeHTTP(w, r)
		return w
	}
	first := call("checkpoint", `{"writerEpoch":2,"checkpointId":"owned-checkpoint"}`)
	if first.Code != 200 {
		t.Fatalf("checkpoint failed: %d", first.Code)
	}
	second := call("checkpoint", `{"writerEpoch":2,"checkpointId":"owned-checkpoint"}`)
	if second.Code != 200 || first.Body.String() != second.Body.String() {
		t.Fatal("lost checkpoint reply changed immutable identity")
	}
	if call("write", `{"path":"late","content":"bGF0ZQ=="}`).Code != http.StatusConflict {
		t.Fatal("old writer mutated frozen Source")
	}
	if call("checkpoint", `{"writerEpoch":1,"checkpointId":"stale-checkpoint"}`).Code != 409 {
		t.Fatal("stale epoch accepted")
	}
	var bundle Bundle
	if json.Unmarshal(first.Body.Bytes(), &bundle) != nil {
		t.Fatal("manifest invalid")
	}
	var output bytes.Buffer
	for i := range bundle.Chunks {
		r := call("chunk", fmt.Sprintf(`{"writerEpoch":2,"checkpointId":"owned-checkpoint","chunk":%d}`, i))
		if r.Code != 200 {
			t.Fatal("chunk unavailable")
		}
		io.Copy(&output, r.Body)
	}
	if int64(output.Len()) != bundle.Bytes {
		t.Fatal("complete Source was truncated")
	}
	if _, err := os.Stat(filepath.Join(root, "tracked")); err != nil {
		t.Fatal("checkpoint released original data")
	}
}

func TestSourceCheckpointFailureReasonsDoNotExposePrivatePaths(t *testing.T) {
	for _, value := range []struct {
		err    error
		reason string
	}{
		{&os.PathError{Op: "open", Path: "private-source-name", Err: unix.EACCES}, "io-13"},
		{ErrPath, "path-boundary"},
		{ErrConflict, "conflicting-writer"},
		{ErrTooLarge, "size-limit"},
		{errors.New("unsupported Source ownership or mode"), "ownership-mode"},
		{errors.New("Source xattrs could not be enumerated"), "xattr-enumeration"},
		{errors.New("private arbitrary error text"), "unconfirmed"},
	} {
		if actual := checkpointFailureReason(value.err); actual != value.reason {
			t.Fatalf("unexpected bounded checkpoint failure category: %s", actual)
		}
	}
}

func TestSourceOwnerCheckpointKeepsTheChangeWriterEpochIndependent(t *testing.T) {
	_, source := bundleFixture(t)
	access := Access{WorkspaceID: "owned-roles", ServiceID: "owned-source", Epoch: 1,
		WriterEpoch: 42, OwnerEpoch: 7, Token: strings.Repeat("a", 32)}
	service, err := NewService(source, access)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Revoke()
	call := func(operation, epoch, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/workspaces/owned-roles/"+operation, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+access.Token)
		r.Header.Set("X-Factory-Source-Service", access.ServiceID)
		r.Header.Set("X-Factory-Source-Epoch", "1")
		r.Header.Set("X-Factory-Writer-Epoch", epoch)
		w := httptest.NewRecorder()
		service.ServeHTTP(w, r)
		return w
	}
	if call("write", "7", `{"path":"wrong-owner-epoch","content":"eA=="}`).Code != 409 {
		t.Fatal("storage ownership replaced the existing Change writer grant")
	}
	if call("write", "42", `{"path":"tracked","content":"ZGlydHkK"}`).Code != 200 {
		t.Fatal("current Change writer could not save")
	}
	if call("fence", "", `{"writerEpoch":43,"writable":false}`).Code != 200 ||
		call("write", "42", `{"path":"old-writer","content":"eA=="}`).Code != 409 {
		t.Fatal("human/Agent handoff did not fence the old Change writer")
	}
	if call("fence", "", `{"writerEpoch":44,"writable":true}`).Code != 200 ||
		call("write", "44", `{"path":"tracked","content":"ZGlydHkK"}`).Code != 200 {
		t.Fatal("the next admitted Change writer could not save")
	}
	checkpoint := `{"writerEpoch":8,"checkpointId":"owned-checkpoint"}`
	if response := call("checkpoint", "", checkpoint); response.Code != 200 {
		t.Fatalf("the separate storage-owner checkpoint was refused: %d", response.Code)
	}
	if call("fence", "", `{"writerEpoch":45,"writable":true}`).Code != 409 {
		t.Fatal("Change writer grant reopened a frozen storage owner")
	}
	if call("fence", "", `{"writerEpoch":45,"writable":false}`).Code != 200 ||
		call("checkpoint", "", checkpoint).Code != 200 {
		t.Fatal("a Change fence changed the retained storage checkpoint identity")
	}
	if call("checkpoint", "", `{"writerEpoch":7,"checkpointId":"owned-checkpoint"}`).Code != 409 ||
		call("chunk", "", `{"writerEpoch":8,"checkpointId":"owned-checkpoint","chunk":0}`).Code != 200 {
		t.Fatal("checkpoint chunks did not retain the exact owner epoch")
	}
}

func TestSourceOwnerCheckpointDoesNotReplaceOrReopenChangeWriterAuthority(t *testing.T) {
	_, source := bundleFixture(t)
	access := Access{WorkspaceID: "owned-workspace", ServiceID: "owned-source", Epoch: 1,
		Token: strings.Repeat("a", 32), WriterEpoch: 41, OwnerEpoch: 1}
	service, err := NewService(source, access)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Revoke()
	call := func(operation, epoch, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/workspaces/owned-workspace/"+operation, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+access.Token)
		r.Header.Set("X-Factory-Source-Service", access.ServiceID)
		r.Header.Set("X-Factory-Source-Epoch", "1")
		r.Header.Set("X-Factory-Writer-Epoch", epoch)
		w := httptest.NewRecorder()
		service.ServeHTTP(w, r)
		return w
	}
	if call("fence", "", `{"writerEpoch":42,"writable":true}`).Code != 200 {
		t.Fatal("existing Change writer epoch could not advance")
	}
	if call("write", "41", `{"path":"late","content":"bGF0ZQ=="}`).Code != 409 {
		t.Fatal("old Change writer mutated Source")
	}
	if call("write", "42", `{"path":"tracked","content":"ZGlydHkK"}`).Code != 200 {
		t.Fatal("current Change writer could not reconcile its identical save")
	}
	if call("write", "1", `{"path":"late","content":"bGF0ZQ=="}`).Code != 409 {
		t.Fatal("storage ownership epoch was accepted as Change writing authority")
	}
	checkpoint := call("checkpoint", "", `{"writerEpoch":2,"checkpointId":"owned-checkpoint"}`)
	if checkpoint.Code != 200 {
		t.Fatalf("Source owner epoch was confused with Change writer epoch: %d", checkpoint.Code)
	}
	if call("checkpoint", "", `{"writerEpoch":3,"checkpointId":"owned-checkpoint"}`).Code != 409 {
		t.Fatal("same checkpoint identity was restamped with another owner epoch")
	}
	if call("chunk", "", `{"writerEpoch":2,"checkpointId":"owned-checkpoint","chunk":0}`).Code != 200 {
		t.Fatal("confirmed Source owner could not read its archive")
	}
	if call("fence", "", `{"writerEpoch":43,"writable":true}`).Code != 409 {
		t.Fatal("a delayed Change handoff reopened a frozen Source owner")
	}
	if call("write", "42", `{"path":"late","content":"bGF0ZQ=="}`).Code != 409 {
		t.Fatal("Change writer mutated Source after its owner froze")
	}
}
