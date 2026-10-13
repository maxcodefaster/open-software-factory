package connector

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxBrowserRequestBytes = 1 << 20

var (
	errBrowserTargetDenied   = errors.New("browser target is not a declared App")
	errBrowserAuthorityEnded = errors.New("browser execution authority ended")
)

type browserAppRoute struct {
	origin string
	target url.URL
	dial   url.URL
}

// The browser will have no network interface outside loopback. Its only App
// connection is a Unix socket to this proxy, outside the browser container.
// Never dial a hostname or destination supplied by a page or an agent.
type browserAppProxy struct {
	authority context.Context
	routes    map[string]browserAppRoute
	transport *http.Transport
}

func newBrowserAppProxy(authority context.Context, channels []Channel, primaryIP string) (*browserAppProxy, error) {
	ip := net.ParseIP(primaryIP)
	if ip == nil || !ip.IsPrivate() {
		return nil, errors.New("browser App destination must be the inspected private primary-container IP")
	}
	return newBrowserAppProxyDestination(authority, channels, ip)
}

// The fixed App-proxy container shares the exact primary container's network
// namespace, but no filesystem or credentials. This also reaches Apps listening
// only on localhost. Its launcher must verify that network namespace identity.
func newBrowserLoopbackAppProxy(authority context.Context, channels []Channel) (*browserAppProxy, error) {
	return newBrowserAppProxyDestination(authority, channels, net.ParseIP("127.0.0.1"))
}

func newBrowserAppProxyDestination(authority context.Context, channels []Channel, ip net.IP) (*browserAppProxy, error) {
	proxy := &browserAppProxy{
		authority: authority,
		routes:    make(map[string]browserAppRoute),
		transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
			ResponseHeaderTimeout: 5 * time.Second,
			IdleConnTimeout:       15 * time.Second,
			MaxIdleConns:          8,
		},
	}
	for _, channel := range channels {
		if channel.Kind != "app" {
			continue
		}
		if !channelPattern.MatchString(channel.Name) || validateTarget(channel.Target) != nil {
			return nil, errors.New("browser channel must be a declared local App")
		}
		target, err := url.Parse(channel.Target)
		if err != nil {
			return nil, errors.New("invalid declared App destination")
		}
		port, err := strconv.Atoi(target.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid declared App port")
		}
		origin := "http://" + channel.Name + ".factory.invalid"
		route := browserAppRoute{origin: origin, target: *target, dial: *target}
		route.dial.Host = net.JoinHostPort(ip.String(), target.Port())
		for _, key := range []string{origin, browserOrigin(target)} {
			if _, exists := proxy.routes[key]; exists {
				return nil, errors.New("browser App origins must be unique")
			}
			proxy.routes[key] = route
		}
	}
	if len(proxy.routes) == 0 || len(proxy.routes) > 16 {
		return nil, errors.New("browser requires between one and eight declared Apps")
	}
	return proxy, nil
}

func browserOrigin(value *url.URL) string {
	host := strings.ToLower(value.Host)
	if value.Port() == "80" {
		host = strings.TrimSuffix(host, ":80")
	}
	return value.Scheme + "://" + host
}

func (proxy *browserAppProxy) route(value *url.URL) (browserAppRoute, bool) {
	if value.Scheme != "http" || value.User != nil || value.Opaque != "" || value.Host == "" {
		return browserAppRoute{}, false
	}
	route, ok := proxy.routes[browserOrigin(value)]
	return route, ok
}

func (proxy *browserAppProxy) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if proxy.authority.Err() != nil {
		http.Error(w, errBrowserAuthorityEnded.Error(), http.StatusGone)
		return
	}
	route, allowed := proxy.route(request.URL)
	if !allowed || request.Method == http.MethodConnect || request.Method == http.MethodTrace {
		http.Error(w, errBrowserTargetDenied.Error(), http.StatusForbidden)
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	originalBody := request.Body
	stop := context.AfterFunc(proxy.authority, func() {
		cancel()
		if originalBody != nil {
			originalBody.Close()
		}
	})
	defer stop()
	defer cancel()
	// Buffer only this bounded request. Reject oversized bodies before any App
	// receives a partial write, including chunked requests with no Content-Length.
	if request.Body != nil {
		body, err := io.ReadAll(io.LimitReader(request.Body, maxBrowserRequestBytes+1))
		request.Body.Close()
		if len(body) > maxBrowserRequestBytes {
			http.Error(w, "browser request exceeds 1 MiB", http.StatusRequestEntityTooLarge)
			return
		}
		if err != nil {
			if proxy.authority.Err() != nil {
				http.Error(w, errBrowserAuthorityEnded.Error(), http.StatusGone)
			} else {
				http.Error(w, "browser request body unavailable", http.StatusBadRequest)
			}
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	request = request.WithContext(ctx)
	original := *request.URL
	forward := httputil.ReverseProxy{
		Transport: proxy.transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(&route.dial)
			r.Out.Host = route.target.Host
			r.Out.Header.Del("Proxy-Authorization")
			r.Out.Header.Del("Proxy-Connection")
			origin, err := url.Parse(r.In.Header.Get("Origin"))
			if err == nil {
				if originRoute, ok := proxy.route(origin); ok {
					r.Out.Header.Set("Origin", browserOrigin(&originRoute.target))
				}
			}
			// Do not call SetXForwarded or propagate untrusted forwarding headers.
		},
		ModifyResponse: func(response *http.Response) error {
			if proxy.authority.Err() != nil {
				return errBrowserAuthorityEnded
			}
			if originalOrigin := request.Header.Get("Origin"); originalOrigin != "" &&
				response.Header.Get("Access-Control-Allow-Origin") == response.Request.Header.Get("Origin") {
				response.Header.Set("Access-Control-Allow-Origin", originalOrigin)
			}
			location := response.Header.Get("Location")
			if location == "" || response.StatusCode < 300 || response.StatusCode >= 400 {
				return nil
			}
			redirect, err := url.Parse(location)
			if err != nil {
				return errBrowserTargetDenied
			}
			redirect = original.ResolveReference(redirect)
			redirectRoute, ok := proxy.route(redirect)
			if !ok {
				return errBrowserTargetDenied
			}
			// Keep redirects on the declared App identity, not its Docker IP.
			canonical, _ := url.Parse(redirectRoute.origin)
			redirect.Host = canonical.Host
			response.Header.Set("Location", redirect.String())
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			switch {
			case proxy.authority.Err() != nil || errors.Is(err, errBrowserAuthorityEnded):
				http.Error(w, errBrowserAuthorityEnded.Error(), http.StatusGone)
			case errors.Is(err, errBrowserTargetDenied):
				http.Error(w, errBrowserTargetDenied.Error(), http.StatusForbidden)
			default:
				http.Error(w, "declared App unavailable", http.StatusServiceUnavailable)
			}
		},
	}
	forward.ServeHTTP(w, request)
}

func (proxy *browserAppProxy) close() {
	proxy.transport.CloseIdleConnections()
}
