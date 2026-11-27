package workspacefiles

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Kernel/filesystem diagnostic only. This opt-in native fixture has no Project
// or control-plane authority and accepts neither paths nor commands.
func TestNativeBundleProbe(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_BUNDLE_PROBE") != "1" {
		t.Skip("explicit native Source bundle probe only")
	}
	if os.Getpid() != 1 || os.Geteuid() != 1000 || os.Getegid() != 1000 {
		t.Fatal("probe requires its own non-root native PID1")
	}
	token := os.Getenv("FACTORY_NATIVE_BUNDLE_TOKEN")
	if token == "" {
		t.Fatal("probe token required")
	}
	os.Unsetenv("FACTORY_NATIVE_BUNDLE_TOKEN")
	type stat struct {
		Inode uint64        `json:"inode"`
		Mode  uint32        `json:"mode"`
		Links uint64        `json:"links"`
		UID   uint32        `json:"uid"`
		GID   uint32        `json:"gid"`
		Size  int64         `json:"size"`
		ATime unix.Timespec `json:"atime"`
		MTime unix.Timespec `json:"mtime"`
		CTime unix.Timespec `json:"ctime"`
	}
	observe := func(root string) map[string]stat {
		values := map[string]stat{}
		for _, name := range []string{".", "file", "dir", "link", "hard"} {
			var value unix.Stat_t
			if unix.Lstat(filepath.Join(root, name), &value) == nil {
				values[name] = stat{value.Ino, value.Mode, uint64(value.Nlink), value.Uid, value.Gid, value.Size, value.Atim, value.Mtim, value.Ctim}
			}
		}
		return values
	}
	var mutex sync.Mutex
	server := &http.Server{Addr: ":18081", ReadHeaderTimeout: time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" || r.URL.Path != "/probe" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer "+token {
				w.WriteHeader(403)
				return
			}
			mutex.Lock()
			defer mutex.Unlock()
			var results []map[string]any
			for _, kind := range []string{"empty", "file", "directory", "symlink", "hardlink"} {
				root, err := os.MkdirTemp("/probe", "case-")
				if err != nil {
					http.Error(w, "owned probe directory unavailable", 503)
					return
				}
				stamp := time.Unix(1_790_000_000, 123456789)
				if kind != "empty" {
					err = os.WriteFile(filepath.Join(root, "file"), []byte("owned Source bytes\n"), 0644)
				}
				if err == nil && kind == "directory" {
					err = os.Mkdir(filepath.Join(root, "dir"), 0755)
				}
				if err == nil && kind == "symlink" {
					err = os.Symlink("file", filepath.Join(root, "link"))
				}
				if err == nil && kind == "hardlink" {
					err = os.Link(filepath.Join(root, "file"), filepath.Join(root, "hard"))
				}
				if err != nil {
					t.Error(err)
					http.Error(w, "probe setup failed", 503)
					return
				}
				for _, name := range []string{"file", "dir", "link", "hard", "."} {
					path := filepath.Join(root, name)
					if _, err := os.Lstat(path); err == nil {
						err = unix.UtimesNanoAt(unix.AT_FDCWD, path, []unix.Timespec{
							unix.NsecToTimespec(stamp.UnixNano() - 123), unix.NsecToTimespec(stamp.UnixNano())}, unix.AT_SYMLINK_NOFOLLOW)
						if err != nil {
							t.Error(err)
						}
					}
				}
				before := observe(root)
				source, err := Open(root)
				output, createErr := os.CreateTemp("/probe", "bundle-")
				var bundle Bundle
				if err == nil && createErr == nil {
					bundle, err = source.ExportBundle(output)
				} else if err == nil {
					err = createErr
				}
				after := observe(root)
				result := map[string]any{"kind": kind, "passed": err == nil, "before": before, "after": after, "bundle": bundle}
				if err != nil {
					result["error"] = err.Error()
				}
				results = append(results, result)
				if source != nil {
					source.Close()
				}
				if output != nil {
					output.Close()
					os.Remove(output.Name())
				}
				os.RemoveAll(root)
			}
			regressions := []map[string]any{
				{"name": "own-read-metadata-and-foreign-write-rejection", "passed": t.Run("owned-directory-read", TestBundleDirectoryReadPreservesItsOwnAtimeAndRejectsForeignMetadata)},
				{"name": "foreign-change-before-first-read-rejected", "passed": t.Run("foreign-before-read", TestBundleDirectoryReadDoesNotAdoptChangesBeforeItsFirstRead)},
				{"name": "other-source-readers-serialized", "passed": t.Run("serialized-source-readers", TestBundleExportSerializesOtherSourceDirectoryReaders)},
			}
			json.NewEncoder(w).Encode(map[string]any{"cases": results, "regressions": regressions})
		})}
	lifetime, cancel := signal.NotifyContext(t.Context(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	ctx, stop := context.WithTimeout(lifetime, 5*time.Minute)
	defer stop()
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Error(err)
			stop()
		}
	}()
	<-ctx.Done()
	server.Close()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal("native probe lifetime expired")
	}
}
