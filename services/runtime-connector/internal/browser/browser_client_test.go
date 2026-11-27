package browser

import (
	"io"
	"strings"
	"testing"
)

func TestBrowserNativeToolObservationIsBounded(t *testing.T) {
	var output browserDockerOutput
	if _, err := io.Copy(&output, strings.NewReader(strings.Repeat("x", 128<<10))); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("x")); err == nil || output.Len() != 128<<10 {
		t.Fatal("native tool observation grew beyond its bound")
	}
}
