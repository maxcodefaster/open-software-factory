package trust

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const (
	ProjectTrustDirectory    = "/run/factory-public"
	ProjectTrustFile         = "/run/factory-public/trust.pem"
	BootstrapTrustProjection = "/run/ate/egress-trust-bundle/trust-bundle.pem"
	BootstrapStateDirectory  = "/var/lib/factory/control"
	BootstrapTrustLimit      = 2 << 20
)

func ValidCertificates(trust []byte) bool {
	if len(trust) == 0 || len(trust) > BootstrapTrustLimit {
		return false
	}
	for len(trust) != 0 {
		trust = bytes.TrimSpace(trust)
		if !bytes.HasPrefix(trust, []byte("-----BEGIN CERTIFICATE-----")) {
			return false
		}
		block, remaining := pem.Decode(trust)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 ||
			bytes.Count(trust[:len(trust)-len(remaining)], []byte("-----BEGIN ")) != 1 {
			return false
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return false
		}
		trust = bytes.TrimSpace(remaining)
	}
	return true
}

func nativeBootstrapTrustOwner(file *os.File, mode os.FileMode) bool {
	info, err := file.Stat()
	var stat unix.Stat_t
	return err == nil && info.Mode() == mode && unix.Fstat(int(file.Fd()), &stat) == nil &&
		stat.Uid == uint32(os.Geteuid()) && stat.Gid == uint32(os.Getegid()) &&
		(mode.IsDir() || stat.Nlink == 1)
}

// PrepareBootstrapTrust manages the combined native + Factory public trust
// bundle. The inner cold step publishes before dockerd; outer readiness and
// Parent only read. UID 0 inside RootlessKit is the same owner as Actor UID
// 1000 outside it. Never follow or repair an unsafe retained directory/file.
func PrepareBootstrapTrust(directory string, native []byte, factory string, prepare bool) (string, error) {
	denied := errors.New("native bootstrap public trust is unavailable")
	if !ValidCertificates(native) || !ValidCertificates([]byte(factory)) ||
		len(native)+1+len(factory) > BootstrapTrustLimit {
		return "", denied
	}
	expected := append(append(append([]byte(nil), native...), '\n'), []byte(factory)...)
	if prepare {
		if err := os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) {
			return "", denied
		}
	}
	fd, err := unix.Open(directory, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", denied
	}
	root := os.NewFile(uintptr(fd), directory)
	defer root.Close()
	if !nativeBootstrapTrustOwner(root, os.ModeDir|0700) {
		return "", denied
	}
	path := filepath.Join(directory, "trust.pem")
	fd, err = unix.Openat(int(root.Fd()), "trust.pem", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err == nil {
		file := os.NewFile(uintptr(fd), path)
		defer file.Close()
		if !nativeBootstrapTrustOwner(file, 0600) {
			return "", denied
		}
		current, err := io.ReadAll(io.LimitReader(file, BootstrapTrustLimit+1))
		if err != nil || len(current) > BootstrapTrustLimit {
			return "", denied
		}
		if bytes.Equal(current, expected) {
			return path, nil
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return "", denied
	}
	if !prepare {
		return "", denied
	}
	temporary, err := os.CreateTemp(directory, ".native-trust-")
	if err != nil {
		return "", denied
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	if _, err := temporary.Write(expected); err != nil {
		return "", denied
	}
	if err := temporary.Sync(); err != nil {
		return "", denied
	}
	if err := temporary.Close(); err != nil {
		return "", denied
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return "", denied
	}
	if err := root.Sync(); err != nil {
		return "", denied
	}
	return path, nil
}
