//go:build !linux

package connector

import (
	"errors"
	"net"
)

func requirePreparedRootPeer(_ *net.UnixConn) error {
	return errors.New("prepared child activation requires the Linux execution boundary")
}
