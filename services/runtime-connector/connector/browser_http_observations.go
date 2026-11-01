package connector

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const browserObservationSocket = "/factory/browser/observations.sock"
const browserHTTPHistorySize = 64
const browserHTTPPageSize = 8
const maxBrowserObservationCursor = 9_007_199_254_740_991

type browserCookieAttributes struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Domain      string `json:"domain"`
	HTTPOnly    bool   `json:"httpOnly"`
	Secure      bool   `json:"secure"`
	SameSite    string `json:"sameSite"`
	Partitioned bool   `json:"partitioned"`
	MaxAge      int    `json:"maxAge"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	Valid       bool   `json:"valid"`
	Unparsed    bool   `json:"unparsedAttributes"`
}

type browserCORSAttributes struct {
	AppAllowOrigin       string `json:"appAllowOrigin"`
	BrowserAllowOrigin   string `json:"browserAllowOrigin"`
	AllowCredentials     string `json:"allowCredentials"`
	VaryOrigin           bool   `json:"varyOrigin"`
	AllowOriginHeaders   int    `json:"allowOriginHeaders"`
	BrowserOriginHeaders int    `json:"browserOriginHeaders"`
	CredentialHeaders    int    `json:"credentialHeaders"`
}

type browserHTTPObservation struct {
	Sequence             uint64                    `json:"sequence"`
	ObservedAt           string                    `json:"observedAt"`
	App                  string                    `json:"app"`
	Method               string                    `json:"method"`
	Path                 string                    `json:"path"`
	RequestOrigin        string                    `json:"requestOrigin"`
	Status               int                       `json:"status"`
	CORS                 browserCORSAttributes     `json:"cors"`
	Cookies              []browserCookieAttributes `json:"cookies"`
	OmittedCookieHeaders int                       `json:"omittedCookieHeaders"`
}

// Only sanitized attributes enter this ring. Raw headers, cookie values, query
// strings and bodies are never retained. A fresh browser gets a fresh ring.
type browserHTTPHistory struct {
	mu       sync.Mutex
	sequence uint64
	records  []browserHTTPObservation
}

type browserHTTPObservationPage struct {
	Observations     []browserHTTPObservation `json:"observations"`
	NextAfter        uint64                   `json:"nextAfter"`
	HistoryTruncated bool                     `json:"historyTruncated"`
	More             bool                     `json:"more"`
	Limits           string                   `json:"limits"`
}

func boundedBrowserHTTPPath(value string) string {
	if value == "" {
		return "/"
	}
	if len(value) > 512 || !strings.HasPrefix(value, "/") || strings.ContainsAny(value, "?#\r\n\x00") {
		return "[omitted invalid or oversized path]"
	}
	return value
}

func (proxy *browserAppProxy) safeObservationOrigin(value string) string {
	switch value {
	case "":
		return "absent"
	case "*", "null":
		return value
	}
	origin, err := url.Parse(value)
	if err != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return "redacted-or-invalid"
	}
	if _, ok := proxy.route(origin); !ok {
		return "redacted-or-invalid"
	}
	return browserOrigin(origin)
}

func (proxy *browserAppProxy) observeHTTP(route browserAppRoute, request *http.Request, response *http.Response, appAllowOrigin string, appOriginHeaders int) {
	record := browserHTTPObservation{
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), App: route.app,
		Method: request.Method, Path: boundedBrowserHTTPPath(request.URL.EscapedPath()),
		RequestOrigin: proxy.safeObservationOrigin(request.Header.Get("Origin")),
		Status:        response.StatusCode, Cookies: []browserCookieAttributes{},
		CORS: browserCORSAttributes{
			AppAllowOrigin:       proxy.safeObservationOrigin(appAllowOrigin),
			BrowserAllowOrigin:   proxy.safeObservationOrigin(response.Header.Get("Access-Control-Allow-Origin")),
			AllowCredentials:     "absent",
			AllowOriginHeaders:   appOriginHeaders,
			BrowserOriginHeaders: len(response.Header.Values("Access-Control-Allow-Origin")),
			CredentialHeaders:    len(response.Header.Values("Access-Control-Allow-Credentials")),
		},
	}
	switch record.Method {
	case "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE":
	default:
		record.Method = "OTHER"
	}
	switch response.Header.Get("Access-Control-Allow-Credentials") {
	case "":
	case "true":
		record.CORS.AllowCredentials = "true"
	default:
		record.CORS.AllowCredentials = "invalid"
	}
	if record.CORS.AllowOriginHeaders > 1 {
		record.CORS.AppAllowOrigin = "multiple-or-invalid"
	}
	if record.CORS.BrowserOriginHeaders > 1 {
		record.CORS.BrowserAllowOrigin = "multiple-or-invalid"
	}
	if record.CORS.CredentialHeaders > 1 {
		record.CORS.AllowCredentials = "multiple-or-invalid"
	}
	for _, line := range response.Header.Values("Vary") {
		for _, name := range strings.Split(line, ",") {
			record.CORS.VaryOrigin = record.CORS.VaryOrigin || strings.EqualFold(strings.TrimSpace(name), "Origin")
		}
	}
	headers := response.Header.Values("Set-Cookie")
	record.OmittedCookieHeaders = len(headers)
	for index, raw := range headers {
		if index >= 4 {
			break
		}
		if len(raw) > 4096 {
			continue
		}
		cookie, err := http.ParseSetCookie(raw)
		if err != nil || len(cookie.Name) > 128 {
			continue
		}
		attributes := browserCookieAttributes{
			Name: cookie.Name, Path: cookie.Path, Domain: "host-only",
			HTTPOnly: cookie.HttpOnly, Secure: cookie.Secure, Partitioned: cookie.Partitioned,
			MaxAge: cookie.MaxAge, SameSite: "unspecified", Valid: cookie.Valid() == nil,
			Unparsed: len(cookie.Unparsed) > 0,
		}
		if cookie.Path != "" {
			attributes.Path = boundedBrowserHTTPPath(cookie.Path)
		}
		if cookie.Domain != "" {
			attributes.Domain = "redacted-or-invalid"
			for _, declared := range proxy.routes {
				if strings.EqualFold(strings.TrimPrefix(cookie.Domain, "."), declared.target.Hostname()) ||
					strings.EqualFold(strings.TrimPrefix(cookie.Domain, "."), strings.TrimPrefix(declared.origin, "http://")) {
					attributes.Domain = cookie.Domain
				}
			}
		}
		switch cookie.SameSite {
		case http.SameSiteDefaultMode:
			attributes.SameSite = "default-or-invalid"
		case http.SameSiteLaxMode:
			attributes.SameSite = "lax"
		case http.SameSiteStrictMode:
			attributes.SameSite = "strict"
		case http.SameSiteNoneMode:
			attributes.SameSite = "none"
		}
		if !cookie.Expires.IsZero() {
			attributes.ExpiresAt = cookie.Expires.UTC().Format(time.RFC3339)
		}
		record.Cookies = append(record.Cookies, attributes)
		record.OmittedCookieHeaders--
	}
	proxy.observations.mu.Lock()
	defer proxy.observations.mu.Unlock()
	proxy.observations.sequence++
	record.Sequence = proxy.observations.sequence
	if len(proxy.observations.records) == browserHTTPHistorySize {
		copy(proxy.observations.records, proxy.observations.records[1:])
		proxy.observations.records[len(proxy.observations.records)-1] = record
	} else {
		proxy.observations.records = append(proxy.observations.records, record)
	}
}

// This handler is mounted ONLY on its separate Unix control socket. The
// browser's HTTP-proxy listener must never route absolute-form App requests here.
func (proxy *browserAppProxy) serveObservations(w http.ResponseWriter, request *http.Request) {
	if proxy.authority.Err() != nil {
		http.Error(w, errBrowserAuthorityEnded.Error(), http.StatusGone)
		return
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	after, parseErr := strconv.ParseUint(query.Get("after"), 10, 64)
	app := query.Get("app")
	route, allowed := proxy.routes["http://"+app+".factory.invalid"]
	if err != nil || parseErr != nil || after > maxBrowserObservationCursor ||
		!allowed || route.app != app || len(query) != 2 || len(query["app"]) != 1 || len(query["after"]) != 1 ||
		request.Method != http.MethodGet || request.URL.IsAbs() || request.URL.Host != "" ||
		request.URL.Path != "/observations" || request.URL.Fragment != "" ||
		request.ContentLength != 0 || len(request.TransferEncoding) != 0 {
		http.Error(w, "unsupported browser observation read", http.StatusForbidden)
		return
	}
	page := browserHTTPObservationPage{
		Observations: []browserHTTPObservation{}, NextAfter: after,
		Limits: "Ephemeral proxied HTTP responses only. Attributes do not prove browser cookie acceptance, an exhaustive write audit or traffic outside this browser. Omitted cookies and truncated history are unknown.",
	}
	proxy.observations.mu.Lock()
	if records := proxy.observations.records; len(records) > 0 {
		page.HistoryTruncated = records[0].Sequence > after+1
	}
	bytes := 0
	for _, record := range proxy.observations.records {
		if record.Sequence <= after || record.App != app {
			continue
		}
		encoded, _ := json.Marshal(record)
		if len(page.Observations) == browserHTTPPageSize || bytes+len(encoded) > 24<<10 {
			page.More = true
			break
		}
		page.Observations = append(page.Observations, record)
		bytes += len(encoded)
		page.NextAfter = record.Sequence
	}
	if !page.More && proxy.observations.sequence > page.NextAfter {
		page.NextAfter = proxy.observations.sequence
	}
	proxy.observations.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(page)
}

func readBrowserHTTPObservations(ctx context.Context, directory, app string, after uint64) (json.RawMessage, error) {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(directory, "socket", "observations.sock"))
		},
	}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://factory-browser-observations.invalid/observations?app="+url.QueryEscape(app)+"&after="+strconv.FormatUint(after, 10), nil)
	if err != nil {
		return nil, errors.New("browser HTTP observation read is invalid")
	}
	response, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}).Do(request)
	unavailable := errors.New("browser HTTP observations unavailable")
	if err != nil {
		return nil, unavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, unavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (32<<10)+1))
	if err != nil || len(body) > 32<<10 || !json.Valid(body) {
		return nil, unavailable
	}
	return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": string(body)}}})
}
