//go:build linux

package connector

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

func requirePreparedRootPeer(connection *net.UnixConn) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	var credential *unix.Ucred
	var cause error
	if err := raw.Control(func(fd uintptr) {
		credential, cause = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if cause != nil || credential == nil || credential.Uid != 0 {
		return errors.New("prepared child activation requires its private root peer")
	}
	return nil
}
