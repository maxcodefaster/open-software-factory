package connector

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
	"golang.org/x/sys/unix"
)

// Reuse the independent Source service as the actual development UID, not as
// Parent/root. The inherited listener is inside the Parent's 0700 directory;
// Project code cannot connect to it or read its random service-only capability.
// No Parent/Child/native control credential is inherited by this process.
func startNativeSource(ctx context.Context, workspaceID string, generation, ownerEpoch, writerEpoch uint64, readOnly bool, directory string, failed context.CancelFunc) (http.Handler, func(), error) {
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, nil, errors.New("native Source identity is unavailable")
	}
	access := workspacefiles.Access{WorkspaceID: workspaceID, ServiceID: "source-" + strings.ReplaceAll(workspaceID, "-", ""), Epoch: generation, Token: hex.EncodeToString(token[:]), OwnerEpoch: ownerEpoch, WriterEpoch: writerEpoch, ReadOnly: readOnly}
	info, err := os.Lstat(directory)
	var owner *syscall.Stat_t
	known := false
	if err == nil {
		owner, known = info.Sys().(*syscall.Stat_t)
	}
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || !known || int(owner.Uid) != os.Geteuid() {
		return nil, nil, errors.New("native Source private directory is unavailable")
	}
	socket := filepath.Join(directory, "source.sock")
	listener, err := listenPrivateUnix(socket)
	if err != nil {
		return nil, nil, errors.New("native Source listener is unavailable")
	}
	defer listener.Close()
	// The subprocess, not Parent, will accept. Keep the original pathname until
	// that exact process has been stopped; do not expose another listening port.
	listener.SetUnlinkOnClose(false)
	file, err := listener.File()
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	archive, closeArchive, err := nativeArchiveView(filepath.Join(directory, "source-archive-view"))
	if err != nil {
		return nil, nil, err
	}
	archiveStarted := false
	defer func() {
		if !archiveStarted {
			closeArchive()
		}
	}()
	binary, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	encoded, _ := json.Marshal(access)
	command := exec.CommandContext(ctx, binary, "native-source")
	command.Stdin = bytes.NewReader(encoded)
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin"}
	command.ExtraFiles = []*os.File{file, archive}
	command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}}}
	if err := command.Start(); err != nil {
		return nil, nil, errors.New("native Source process could not start")
	}
	archiveStarted = true
	archive.Close()
	done := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(done)
		failed()
	}()
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
		ResponseHeaderTimeout: 10 * time.Second,
	}
	cleanup := func() {
		_ = command.Process.Kill()
		<-done
		transport.CloseIdleConnections()
		closeArchive()
		// removeStaleSocket checks the exact file type/UID and refuses a live
		// replacement; never unlink an unrelated path during error cleanup.
		_ = removeStaleSocket(socket)
	}
	proxy := &httputil.ReverseProxy{
		ErrorLog: log.New(io.Discard, "", 0),
		Director: func(request *http.Request) {
			request.URL.Scheme, request.URL.Host = "http", "source.internal"
			request.Header.Set("Authorization", "Bearer "+access.Token)
			request.Header.Set("X-Factory-Source-Service", access.ServiceID)
			request.Header.Set("X-Factory-Source-Epoch", fmt.Sprint(access.Epoch))
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(response, "Native Source is unavailable", http.StatusServiceUnavailable)
		},
	}
	return proxy, cleanup, nil
}

// RunSourceHost is Factory's small independent Source-service launcher. Its
// input is server-local, never accepted from an editor. The existing Go service
// and its fixed API remain the only filesystem authority.
func RunSourceHost(ctx context.Context) error {
	var input struct {
		Root   string                `json:"root"`
		Socket string                `json:"socket"`
		Access workspacefiles.Access `json:"access"`
	}
	d := json.NewDecoder(io.LimitReader(os.Stdin, 16385))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF || !filepath.IsAbs(input.Root) || filepath.Clean(input.Root) != input.Root || filepath.Base(input.Root) != "project" || !filepath.IsAbs(input.Socket) || input.Access.WriterEpoch == 0 {
		return errors.New("independent Source assignment is invalid")
	}
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		return errors.New("independent Source identity is unsupported")
	}
	parent := filepath.Dir(input.Socket)
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || int(info.Sys().(*syscall.Stat_t).Uid) != os.Geteuid() {
		return errors.New("independent Source private directory is unavailable")
	}
	listener, err := listenPrivateUnix(input.Socket)
	if err != nil {
		return errors.New("independent Source listener unavailable")
	}
	defer listener.Close()
	listener.SetUnlinkOnClose(false)
	fd, err := listener.File()
	if err != nil {
		return err
	}
	defer fd.Close()
	root, err := os.Open(input.Root)
	if err != nil {
		return errors.New("independent Source root unavailable")
	}
	defer root.Close()
	spoolPath := filepath.Join(parent, "bundle")
	if err := os.Mkdir(spoolPath, 0700); err != nil {
		return errors.New("independent Source spool already exists")
	}
	if err := os.Chown(spoolPath, 1000, 1000); err != nil {
		return err
	}
	spool, err := os.Open(spoolPath)
	if err != nil {
		return err
	}
	defer spool.Close()
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	encoded, _ := json.Marshal(input.Access)
	command := exec.CommandContext(ctx, binary, "source-service")
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/proc/self/fd/5"}
	command.Stdin = bytes.NewReader(encoded)
	command.ExtraFiles = []*os.File{fd, root, spool}
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = 5 * time.Second
	if os.Geteuid() == 0 {
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{}}}
	}
	if err := command.Start(); err != nil {
		return errors.New("independent Source could not start")
	}
	listener.Close()
	fd.Close()
	root.Close()
	spool.Close()
	fmt.Fprintln(os.Stdout, "ready")
	err = command.Wait()
	_ = removeStaleSocket(input.Socket)
	if entries, readErr := os.ReadDir(spoolPath); readErr == nil {
		for _, entry := range entries {
			name := filepath.Join(spoolPath, entry.Name())
			info, statErr := os.Lstat(name)
			if statErr == nil && strings.HasPrefix(entry.Name(), "factory-source-bundle-") && info.Mode().IsRegular() && info.Sys().(*syscall.Stat_t).Uid == 1000 && info.Sys().(*syscall.Stat_t).Nlink == 1 {
				_ = os.Remove(name)
			}
		}
		_ = os.Remove(spoolPath)
	}
	if ctx.Err() != nil {
		return nil
	}
	if err != nil {
		return errors.New("independent Source exited")
	}
	return nil
}

func RunSourceMaterialize(inputPath, destination string) error {
	if !filepath.IsAbs(inputPath) || !filepath.IsAbs(destination) || filepath.Base(destination) != "project" {
		return errors.New("invalid Source materialization paths")
	}
	file, err := os.Open(inputPath)
	if err != nil {
		return errors.New("confirmed Source bundle unavailable")
	}
	defer file.Close()
	if err := workspacefiles.MaterializeBundle(file, destination); err != nil {
		return errors.New("complete Source materialization failed; old data retained")
	}
	return nil
}

// RunSubstrateSource serves exactly the native checkout through the inherited
// private listener. It never initializes/reclones Source or runs Project code.
func RunSubstrateSource(ctx context.Context) error { return runSourceService(ctx, false) }
func RunSourceService(ctx context.Context) error   { return runSourceService(ctx, true) }
func runSourceService(ctx context.Context, descriptor bool) error {
	if os.Geteuid() != 1000 || os.Getegid() != 1000 {
		return errors.New("native Source requires the development identity")
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return errors.New("native Source privileges could not be bounded")
	}
	var access workspacefiles.Access
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 8193))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&access) != nil || decoder.Decode(new(any)) != io.EOF || access.WriterEpoch == 0 {
		return errors.New("native Source assignment is invalid")
	}
	file := os.NewFile(3, "native-source-listener")
	listener, err := net.FileListener(file)
	file.Close()
	if err != nil {
		return errors.New("native Source inherited listener is unavailable")
	}
	defer listener.Close()
	var source *workspacefiles.Source
	if descriptor {
		root := os.NewFile(4, "Source-root")
		source, err = workspacefiles.OpenDescriptor(root)
		root.Close()
	} else {
		source, err = workspacefiles.Open("/home/rootless/persist/project")
	}
	if err != nil {
		return errors.New("native canonical Source is unavailable")
	}
	defer source.Close()
	if !descriptor {
		archive := os.NewFile(4, "native-Source-archive-view")
		err = source.AttachArchiveDescriptor(archive)
		archive.Close()
		if err != nil {
			return err
		}
	}
	service, err := workspacefiles.NewService(source, access)
	if err != nil {
		return err
	}
	defer service.Revoke()
	server := &http.Server{Handler: service, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10}
	go func() {
		<-ctx.Done()
		service.Revoke()
		_ = server.Close()
	}()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return errors.New("native Source service stopped")
}
