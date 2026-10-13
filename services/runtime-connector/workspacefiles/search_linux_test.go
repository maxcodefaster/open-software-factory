package workspacefiles

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSourceSearchCanonicalFilesAndUnicode(t *testing.T) {
	source, checkout := testSource(t)
	if err := os.Mkdir(filepath.Join(checkout, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "src", "app.ts"), []byte("hello\n😀 café TODO\ntodos TODO\n"), 0644); err != nil {
		t.Fatal(err)
	}
	result, err := source.Search(context.Background(), Search{Query: "todo", WholeWord: true, Include: []string{"**/*.ts"}})
	if err != nil || len(result.Results) != 1 || len(result.Results[0].Matches) != 2 {
		t.Fatalf("real source search: %#v, %v", result, err)
	}
	match := result.Results[0].Matches[0]
	if match.Line != 2 || match.Character != 8 || match.Length != 4 || match.LineText != "😀 café TODO" {
		t.Fatalf("incorrect Unicode match position: %#v", match)
	}
	result, err = source.Search(context.Background(), Search{Query: "T.DO", Regex: true, MatchCase: true, Exclude: []string{"src/**"}})
	if err != nil || len(result.Results) != 0 {
		t.Fatalf("excluded source search: %#v, %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := source.Search(ctx, Search{Query: "TODO"}); err == nil {
		t.Fatal("cancelled search continued")
	}
}

func TestSourceSearchCannotReadProtectedLinks(t *testing.T) {
	source, checkout := testSource(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.ts"), []byte("PRIVATE_SEARCH_MATCH"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(checkout, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(outside, "secret.ts"), filepath.Join(checkout, "hardlink.ts")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(checkout, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, ".git", "config"), []byte("PRIVATE_SEARCH_MATCH"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := source.Search(context.Background(), Search{Query: "PRIVATE_SEARCH_MATCH", Include: []string{"**"}})
	if err != nil || len(result.Results) != 0 {
		t.Fatalf("search read protected source: %#v, %v", result, err)
	}
}
