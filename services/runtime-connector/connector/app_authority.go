package connector

import (
	"errors"
	"net/url"
)

// Factory strips client forwarding headers, then reconstructs this pair from
// the authenticated App URL. Keep that browser authority without changing the
// admitted loopback dial target. Internal requests have no proxy context.
func appProxyHost(channel Channel, headers map[string]string) (string, error) {
	if channel.Kind != "app" {
		return "", nil
	}
	host, protocol := headers["x-forwarded-host"], headers["x-forwarded-proto"]
	if host == "" && protocol == "" {
		return "", nil
	}
	if protocol != "http" && protocol != "https" {
		return "", errors.New("invalid App proxy authority")
	}
	value, err := url.Parse(protocol + "://" + host)
	if err != nil || value.Hostname() == "" || value.Host != host || value.User != nil ||
		value.Path != "" || value.RawQuery != "" || value.ForceQuery || value.Fragment != "" {
		return "", errors.New("invalid App proxy authority")
	}
	return host, nil
}
