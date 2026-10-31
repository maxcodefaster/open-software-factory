package connector

import "strings"

// Registry output is untrusted and may contain credentials. Only these static
// classes leave acquisition; the bounded command tail remains process-local.
func projectImageDownloadDiagnostic(diagnostic string) string {
	value := strings.ToLower(diagnostic)
	for _, failure := range []struct {
		patterns []string
		message  string
	}{
		{[]string{"no space left on device", "disk quota exceeded"}, "Project image download failed: Sandbox storage is exhausted"},
		{[]string{"cannot allocate memory", "out of memory"}, "Project image download failed: image acquisition reported insufficient memory"},
		{[]string{"x509:", "certificate verify failed", "tls: failed to verify certificate"}, "Project image download failed: Registry certificate trust failed"},
		{[]string{"unauthorized", "authentication required", "forbidden", "denied:"}, "Project image download failed: Registry authentication was rejected"},
		{[]string{"toomanyrequests", "too many requests", "status code 429", "status: 429"}, "Project image download failed: Registry rate limit was reached"},
		{[]string{"manifest unknown", "manifest not found"}, "Project image download failed: Registry image manifest is unavailable"},
	} {
		for _, pattern := range failure.patterns {
			if strings.Contains(value, pattern) {
				return failure.message
			}
		}
	}
	return "Project image download failed; check Registry availability, approved credentials and CA trust"
}

func retryableImageDownload(diagnostic string) bool {
	value := strings.ToLower(diagnostic)
	for _, permanent := range []string{
		"x509:", "certificate verify failed", "tls: failed to verify certificate",
		"unauthorized", "authentication required", "forbidden", "denied:",
		"manifest unknown", "manifest not found", "invalid reference",
		"no space left on device", "disk quota exceeded", "cannot allocate memory", "out of memory",
		"toomanyrequests", "too many requests", "status code 429", "status: 429",
	} {
		if strings.Contains(value, permanent) {
			return false
		}
	}
	for _, transient := range []string{
		"connection refused", "connection reset", "no route to host", "no such host",
		"i/o timeout", "tls handshake timeout", "context deadline exceeded", "unexpected eof",
		"temporary failure in name resolution", "server misbehaving",
		"500 internal server error", "502 bad gateway", "503 service unavailable", "504 gateway timeout",
	} {
		if strings.Contains(value, transient) {
			return true
		}
	}
	return false
}
