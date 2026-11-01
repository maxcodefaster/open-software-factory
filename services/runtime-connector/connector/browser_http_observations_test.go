package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestBrowserHTTPObservationsRetainAttributesWithoutCredentials(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-request-secret" {
			t.Error("App did not receive its original authorized request")
		}
		w.Header().Add("Set-Cookie", "session=private-cookie-secret; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=3600")
		w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("X-Private", "private-response-secret")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	request := httptest.NewRequest(http.MethodPost, "http://web.factory.invalid/admin/login?secret=private-query-secret", strings.NewReader("private-body-secret"))
	request.Header.Set("Authorization", "Bearer private-request-secret")
	request.Header.Set("Origin", "http://web.factory.invalid")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatal("actual App request failed", response.Code)
	}
	read := httptest.NewRecorder()
	proxy.serveObservations(read, httptest.NewRequest(http.MethodGet, "/observations?app=web&after=0", nil))
	if read.Code != http.StatusOK {
		t.Fatalf("safe observation is unavailable: %d %s", read.Code, read.Body.String())
	}
	var result struct {
		Observations []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
			Status int    `json:"status"`
			CORS   struct {
				AppAllowOrigin     string `json:"appAllowOrigin"`
				BrowserAllowOrigin string `json:"browserAllowOrigin"`
				AllowCredentials   string `json:"allowCredentials"`
			} `json:"cors"`
			Cookies []struct {
				Name     string `json:"name"`
				Path     string `json:"path"`
				HTTPOnly bool   `json:"httpOnly"`
				Secure   bool   `json:"secure"`
				SameSite string `json:"sameSite"`
				MaxAge   int    `json:"maxAge"`
			} `json:"cookies"`
		} `json:"observations"`
	}
	if json.Unmarshal(read.Body.Bytes(), &result) != nil || len(result.Observations) != 1 {
		t.Fatal("missing actual response metadata", read.Body.String())
	}
	got := result.Observations[0]
	if got.Method != "POST" || got.Path != "/admin/login" || got.Status != 204 ||
		got.CORS.AppAllowOrigin != app.URL ||
		got.CORS.BrowserAllowOrigin != "http://web.factory.invalid" || got.CORS.AllowCredentials != "true" ||
		len(got.Cookies) != 1 {
		t.Fatal("response metadata differs from actual App traffic", read.Body.String())
	}
	cookie := got.Cookies[0]
	if cookie.Name != "session" || cookie.Path != "/admin" || !cookie.HTTPOnly ||
		!cookie.Secure || cookie.SameSite != "lax" || cookie.MaxAge != 3600 {
		t.Fatal("cookie security attributes were lost", read.Body.String())
	}
	for _, secret := range []string{"private-request-secret", "private-cookie-secret", "private-query-secret", "private-body-secret", "private-response-secret", "Authorization", "X-Private"} {
		if strings.Contains(read.Body.String(), secret) {
			t.Errorf("safe observation exposed %q", secret)
		}
	}
}

func readHTTPObservationPage(t *testing.T, proxy *browserAppProxy, after uint64) browserHTTPObservationPage {
	t.Helper()
	response := httptest.NewRecorder()
	proxy.serveObservations(response, httptest.NewRequest(http.MethodGet, "/observations?app=web&after="+strconv.FormatUint(after, 10), nil))
	var page browserHTTPObservationPage
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil {
		t.Fatal("invalid HTTP observation page", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("HTTP observations may not be cached")
	}
	return page
}

func TestBrowserHTTPObservationsBoundHistoryPageCookiesAndUntrustedFields(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "https://private-origin-secret.invalid")
		w.Header().Set("Access-Control-Allow-Credentials", "private-credentials-secret")
		w.Header().Set("Vary", "Accept-Encoding, Origin")
		for i := 0; i < 9; i++ {
			w.Header().Add("Set-Cookie", "session"+strconv.Itoa(i)+"=private-cookie-secret; Domain=private-domain-secret.invalid; Path=/admin; SameSite=None; Secure; Partitioned")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	for i := 0; i < browserHTTPHistorySize+3; i++ {
		request := httptest.NewRequest("PRIVATE-METHOD-SECRET", "http://web.factory.invalid/"+strings.Repeat("x", 513)+"?private-query-secret=1", nil)
		request.Header.Set("Origin", "https://private-request-origin-secret.invalid")
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatal("owned App request failed")
		}
	}
	page := readHTTPObservationPage(t, proxy, 0)
	if len(proxy.observations.records) != browserHTTPHistorySize ||
		len(page.Observations) != browserHTTPPageSize || !page.HistoryTruncated || !page.More ||
		page.Observations[0].Sequence != 4 {
		t.Fatal("history is unbounded or hides eviction", page)
	}
	for _, observation := range page.Observations {
		if observation.OmittedCookieHeaders != 5 || len(observation.Cookies) != 4 ||
			observation.RequestOrigin != "redacted-or-invalid" ||
			observation.CORS.AppAllowOrigin != "redacted-or-invalid" ||
			observation.CORS.AllowCredentials != "invalid" || !observation.CORS.VaryOrigin ||
			observation.Method != "OTHER" || !strings.Contains(observation.Path, "omitted") {
			t.Fatal("untrusted response metadata lost its explicit limits", observation)
		}
		if !observation.Cookies[0].Partitioned || observation.Cookies[0].Domain != "redacted-or-invalid" {
			t.Fatal("cookie metadata leaked its arbitrary domain or lost partitioning")
		}
	}
	wire, _ := json.Marshal(page)
	if len(wire) > 32<<10 || strings.Contains(string(wire), "private-") {
		t.Fatal("observation response is oversized or retains untrusted secrets")
	}
	seen := len(page.Observations)
	for page.More {
		previous := page.NextAfter
		page = readHTTPObservationPage(t, proxy, previous)
		if page.HistoryTruncated || page.NextAfter <= previous {
			t.Fatal("cursor did not make bounded progress")
		}
		seen += len(page.Observations)
	}
	if seen != browserHTTPHistorySize {
		t.Fatal("bounded pagination lost retained responses", seen)
	}
	empty := readHTTPObservationPage(t, proxy, page.NextAfter)
	if len(empty.Observations) != 0 || empty.More {
		t.Fatal("read replayed App responses")
	}
	fresh := testBrowserProxy(t, context.Background(), app)
	if len(readHTTPObservationPage(t, fresh, 0).Observations) != 0 {
		t.Fatal("new browser inherited another session's observations")
	}
}

func TestBrowserHTTPObservationControlCannotBeReachedThroughAppProxy(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer app.Close()
	proxy := testBrowserProxy(t, ctx, app)
	for _, target := range []string{
		"/observations?app=web&after=0",
		"http://factory-browser-observations.invalid/observations?app=web&after=0",
		"http://127.0.0.1/observations?app=web&after=0",
	} {
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusForbidden {
			t.Fatal("browser reached the internal observation control route", target, response.Code)
		}
	}
	// A declared App can own the same path. It still reaches only that App,
	// never the Unix control handler or another page's observations.
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://web.factory.invalid/observations?app=web&after=0", nil))
	if response.Code != http.StatusNoContent {
		t.Fatal("declared App route was replaced with a Factory control route")
	}
	for _, target := range []string{
		"http://web.factory.invalid/observations?app=web&after=0",
		"/observations?app=other&after=0",
		"/observations?app=web&after=-1",
		"/observations?app=web&after=1.5",
		"/observations?app=web&after=9007199254740992",
		"/observations?app=web&after=0&after=1",
		"/observations?app=web&after=0&url=http://other/",
	} {
		denied := httptest.NewRecorder()
		proxy.serveObservations(denied, httptest.NewRequest(http.MethodGet, target, nil))
		if denied.Code != http.StatusForbidden {
			t.Fatal("control read accepted arbitrary authority", target, denied.Code)
		}
	}
	denied := httptest.NewRecorder()
	proxy.serveObservations(denied, httptest.NewRequest(http.MethodPost, "/observations?app=web&after=0", strings.NewReader("body")))
	if denied.Code != http.StatusForbidden {
		t.Fatal("control read accepted a request body or method")
	}
	cancel()
	expired := httptest.NewRecorder()
	proxy.serveObservations(expired, httptest.NewRequest(http.MethodGet, "/observations?app=web&after=0", nil))
	if expired.Code != http.StatusGone || strings.Contains(expired.Body.String(), "observations") {
		t.Fatal("expired authority retained access to observations")
	}
}

func TestBrowserHTTPObservationsDoNotHideDuplicateCORSHeaders(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 2; i++ {
			w.Header().Add("Access-Control-Allow-Origin", r.Header.Get("Origin"))
			w.Header().Add("Access-Control-Allow-Credentials", "true")
		}
	}))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	request := httptest.NewRequest(http.MethodGet, "http://web.factory.invalid/", nil)
	request.Header.Set("Origin", "http://web.factory.invalid")
	proxy.ServeHTTP(httptest.NewRecorder(), request)
	page := readHTTPObservationPage(t, proxy, 0)
	if len(page.Observations) != 1 {
		t.Fatal("duplicate-header response was not observed")
	}
	cors := page.Observations[0].CORS
	if cors.AllowOriginHeaders != 2 || cors.CredentialHeaders != 2 ||
		cors.BrowserOriginHeaders != 1 ||
		cors.AppAllowOrigin != "multiple-or-invalid" || cors.BrowserAllowOrigin != "http://web.factory.invalid" ||
		cors.AllowCredentials != "multiple-or-invalid" {
		t.Fatal("first header concealed invalid duplicate CORS attributes", cors)
	}
}

func TestBrowserHTTPObservationsPaginateByBytesWithoutLosingLargeCookieMetadata(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 4; i++ {
			w.Header().Add("Set-Cookie", strings.Repeat("c", 127)+strconv.Itoa(i)+"=secret; Path=/"+strings.Repeat("p", 511)+"; Domain=web.factory.invalid; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=9223372036854775807; Expires=Fri, 31 Dec 9999 23:59:59 GMT")
		}
	}))
	defer app.Close()
	proxy := testBrowserProxy(t, context.Background(), app)
	for i := 0; i < browserHTTPPageSize+1; i++ {
		request := httptest.NewRequest(http.MethodGet, "http://web.factory.invalid/"+strings.Repeat("p", 511), nil)
		proxy.ServeHTTP(httptest.NewRecorder(), request)
	}
	var cursor uint64
	total := 0
	for {
		page := readHTTPObservationPage(t, proxy, cursor)
		encoded, err := json.Marshal(page)
		if err != nil || len(encoded) > 30<<10 {
			t.Fatal("HTTP page cannot pass through its bounded browser reader", len(encoded), err)
		}
		if page.NextAfter <= cursor || len(page.Observations) == 0 {
			t.Fatal("large observations stalled pagination")
		}
		total += len(page.Observations)
		cursor = page.NextAfter
		if !page.More {
			break
		}
	}
	if total != browserHTTPPageSize+1 {
		t.Fatal("byte-bounded pagination omitted response metadata", total)
	}
}
