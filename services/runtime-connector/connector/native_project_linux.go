package connector

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
	"golang.org/x/sys/unix"
)

func nativeProjectTrust() ([]byte, error) {
	var directory unix.Stat_t
	if unix.Lstat(nativeProjectTrustDirectory, &directory) != nil ||
		directory.Mode&unix.S_IFMT != unix.S_IFDIR || directory.Uid != 0 ||
		directory.Gid != 0 || directory.Mode&0022 != 0 {
		return nil, errors.New("native Project public trust owner is unavailable")
	}
	fd, err := unix.Open(nativeProjectTrustFile, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("native Project public trust is unavailable")
	}
	file := os.NewFile(uintptr(fd), nativeProjectTrustFile)
	defer file.Close()
	var info unix.Stat_t
	if unix.Fstat(fd, &info) != nil || info.Mode&unix.S_IFMT != unix.S_IFREG ||
		info.Uid != 0 || info.Gid != 0 || info.Mode&0022 != 0 || info.Nlink != 1 {
		return nil, errors.New("native Project public trust is not protected")
	}
	content, err := io.ReadAll(io.LimitReader(file, nativeBootstrapTrustLimit+1))
	if err != nil || !nativeBootstrapCertificates(content) {
		return nil, errors.New("native Project public trust is invalid")
	}
	return content, nil
}

// Substrate starts this process directly as the OCI image's existing user.
// It creates no container, namespace, daemon or lifecycle supervisor.
func RunSubstrateProject(ctx context.Context) error {
	text := os.Getenv("FACTORY_NATIVE_PROJECT")
	os.Unsetenv("FACTORY_NATIVE_PROJECT")
	if os.Getpid() != 1 || os.Geteuid() == 0 || os.Getegid() == 0 {
		return errors.New("native Project requires non-root container PID1")
	}
	if err := ProtectProcess(); err != nil {
		return err
	}
	entry, err := decodeNativeProject(text)
	if err != nil {
		return err
	}
	if _, _, errno := syscall.AllThreadsSyscall6(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0); errno != 0 {
		return errors.New("native Project privileges could not be bounded")
	}
	if _, err := nativeWriterCallerIdentity(); err != nil {
		return err
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	actorUID := strings.TrimSpace(string(uid))
	if err != nil || !sourceRestoreUUID.MatchString(actorUID) {
		return errors.New("native Project Actor identity is unavailable")
	}
	var trust []byte
	deadline := time.Now().Add(120 * time.Second)
	for {
		trust, err = nativeProjectTrust()
		if err == nil {
			break
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			return errors.New("native Project trust preparation is unconfirmed")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(trust) {
		return errors.New("native Project serving trust is invalid")
	}
	client := &http.Client{Timeout: 15 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	admission, cancel := context.WithTimeout(ctx, 3*time.Minute)
	environment, err := readNativeProjectEnvironment(admission, entry, actorUID, client)
	cancel()
	if err != nil {
		return err
	}
	values := map[string]string{
		"SSL_CERT_FILE": nativeProjectTrustFile, "GIT_SSL_CAINFO": nativeProjectTrustFile,
		"NODE_EXTRA_CA_CERTS": nativeProjectTrustFile,
	}
	for _, variable := range environment.Bundle.Variables {
		values[variable.Name] = variable.Value
	}
	// No bootstrap capability is inherited by Project preparation or services.
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if strings.HasPrefix(name, "FACTORY_") {
			os.Unsetenv(name)
		}
	}
	for name, value := range values {
		if err := os.Setenv(name, value); err != nil {
			return err
		}
	}
	if entry.Container != "work" {
		path, err := exec.LookPath(entry.Command[0])
		if err != nil {
			return errors.New("native service entrypoint is unavailable")
		}
		return syscall.Exec(path, entry.Command, os.Environ())
	}
	if os.Geteuid() != 1000 || os.Getegid() != 1000 {
		return errors.New("native Work image must use the Source development UID/GID 1000")
	}
	if filepath.Base(entry.Assignment.WorkspaceFolder) != "project" {
		return errors.New("native Work checkout does not match the Source mount")
	}
	entry.Assignment.RuntimeEnvironment = values
	entry.Assignment.SetNativeActorUID(actorUID)
	entry.Assignment.SetNativeWriters(writergate.NewGate(func(refresh context.Context) error {
		refresh, cancel := context.WithTimeout(refresh, 30*time.Second)
		defer cancel()
		_, err := readNativeProjectEnvironment(refresh, entry, actorUID, client)
		return err
	}))
	if entry.Preparation != nil {
		argv := entry.Preparation.Command
		command := exec.CommandContext(ctx, argv[0], argv[1:]...)
		command.Dir, command.Env = entry.Assignment.WorkspaceFolder, os.Environ()
		command.Stdout, command.Stderr = os.Stdout, os.Stderr
		PrepareAssignedProcess(command)
		command.Cancel = func() error { StopAssignedProcess(command); return nil }
		if err := command.Run(); err != nil {
			return errors.New("native Work preparation failed")
		}
	}
	return RunChild(ctx, entry.Assignment, entry.ChildToken)
}
