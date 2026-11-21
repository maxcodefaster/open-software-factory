package connector

import (
	"strings"
	"testing"
)

func TestBrowserWorkerFixedConfiguration(t *testing.T) {
	arguments, err := browserWorkerArguments([]Channel{
		{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if arguments[0] != "/opt/factory/browser-mcp/entrypoint.js" {
		t.Fatal("worker must use the package-bin launcher checked while building its image")
	}
	flags := strings.Join(arguments, "\n")
	for _, expected := range []string{
		"--isolated", "--headless", "--no-javascript-evaluation", "--no-usage-statistics",
		"--no-category-network", "--no-category-performance", "--no-category-extensions",
		"--no-category-experimental-webmcp", "--no-category-experimental-third-party",
		"--proxy-server=http://127.0.0.1:3128", "--chrome-arg=--proxy-bypass-list=<-loopback>",
		"--screenshot-max-width=1280", "--screenshot-max-height=720",
		"--allowed-url-pattern=http://web.factory.invalid/*",
		"--allowed-url-pattern=http://127.0.0.1:3000/*",
	} {
		if !strings.Contains(flags, expected) {
			t.Errorf("missing fixed flag %s", expected)
		}
	}
}

func TestBrowserWorkerRejectsNonAppAndInvalidAssignments(t *testing.T) {
	for _, channels := range [][]Channel{
		nil,
		{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:4096"}},
		{{Name: "web", Kind: "app", Target: "http://169.254.169.254:80"}},
		{{Name: "web*", Kind: "app", Target: "http://127.0.0.1:3000"}},
		{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}, {Name: "web", Kind: "app", Target: "http://127.0.0.1:3001"}},
	} {
		if _, err := browserWorkerArguments(channels); err == nil {
			t.Errorf("unexpected browser authority for %+v", channels)
		}
	}
}
