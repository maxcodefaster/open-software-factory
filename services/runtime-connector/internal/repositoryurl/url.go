package repositoryurl

import (
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
)

// Valid checks transport for a repository endpoint supplied by a trusted Factory
// assignment. Resource ownership and checkout identity are checked separately.
func Valid(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	switch parsed.Scheme {
	case "https":
		return parsed.Host != ""
	case "file":
		return parsed.Host == "" && filepath.IsAbs(parsed.Path)
	case "http":
		host := parsed.Hostname()
		if host == "host.orb.internal" || host == "localhost" {
			return true
		}
		address, err := netip.ParseAddr(host)
		if err != nil || address.Zone() != "" {
			return false
		}
		address = address.Unmap()
		return address.IsPrivate() || address.IsLoopback()
	default:
		return false
	}
}
