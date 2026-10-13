package workspacefiles

import (
	"bytes"
	"context"
	"errors"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type Search struct {
	Query      string   `json:"query"`
	Regex      bool     `json:"regex,omitempty"`
	MatchCase  bool     `json:"matchCase,omitempty"`
	WholeWord  bool     `json:"wholeWord,omitempty"`
	Include    []string `json:"include,omitempty"`
	Exclude    []string `json:"exclude,omitempty"`
	MaxResults int      `json:"maxResults,omitempty"`
}

type SearchMatch struct {
	Line      int    `json:"line"`
	Character int    `json:"character"`
	Length    int    `json:"length"`
	LineText  string `json:"lineText"`
}

type SearchFile struct {
	Path    string        `json:"path"`
	Matches []SearchMatch `json:"matches"`
}

type SearchResult struct {
	Results   []SearchFile `json:"results"`
	Truncated bool         `json:"truncated"`
}

func globMatches(pattern, name string) bool {
	if !strings.Contains(pattern, "/") {
		matched, _ := path.Match(pattern, path.Base(name))
		return matched
	}
	patterns, names := strings.Split(pattern, "/"), strings.Split(name, "/")
	memo := make(map[[2]int]bool)
	seen := make(map[[2]int]bool)
	var match func(int, int) bool
	match = func(p, n int) bool {
		key := [2]int{p, n}
		if seen[key] {
			return memo[key]
		}
		seen[key] = true
		result := false
		if p == len(patterns) {
			result = n == len(names)
		} else if patterns[p] == "**" {
			result = match(p+1, n) || (n < len(names) && match(p, n+1))
		} else if n < len(names) {
			matched, _ := path.Match(patterns[p], names[n])
			result = matched && match(p+1, n+1)
		}
		memo[key] = result
		return result
	}
	return match(0, 0)
}

func matchesAny(patterns []string, name string) bool {
	for _, pattern := range patterns {
		if globMatches(pattern, name) {
			return true
		}
	}
	return false
}

func wordRune(value rune) bool {
	return unicode.IsLetter(value) || unicode.IsDigit(value) || value == '_'
}

func wholeWord(line string, start, end int) bool {
	previous, _ := utf8.DecodeLastRuneInString(line[:start])
	next, _ := utf8.DecodeRuneInString(line[end:])
	return (start == 0 || !wordRune(previous)) && (end == len(line) || !wordRune(next))
}

func (source *Source) Search(ctx context.Context, input Search) (SearchResult, error) {
	result := SearchResult{Results: make([]SearchFile, 0)}
	if len(input.Query) == 0 || len(input.Query) > 256 || len(input.Include)+len(input.Exclude) > 16 {
		return result, ErrPath
	}
	for _, pattern := range append(append([]string{}, input.Include...), input.Exclude...) {
		if len(pattern) > 256 || strings.ContainsRune(pattern, 0) {
			return result, ErrPath
		}
		if _, err := path.Match(pattern, ""); err != nil {
			return result, ErrPath
		}
	}
	query := input.Query
	if !input.Regex {
		query = regexp.QuoteMeta(query)
	}
	if !input.MatchCase {
		query = "(?i)" + query
	}
	matcher, err := regexp.Compile(query)
	if err != nil {
		return result, ErrPath
	}
	limit := input.MaxResults
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	var visited, scanned, matches int
	var visit func(string, int) error
	visit = func(directory string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if visited >= 10_000 || scanned >= 32<<20 || matches >= limit || depth > 64 {
			result.Truncated = true
			return nil
		}
		entries, err := source.List(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if visited >= 10_000 || scanned >= 32<<20 || matches >= limit {
				result.Truncated = true
				return nil
			}
			visited++
			name := path.Join(directory, entry.Name)
			if excludedWatchPath(name) || matchesAny(input.Exclude, name) {
				continue
			}
			if entry.Kind == "directory" {
				if err := visit(name, depth+1); err != nil && !errors.Is(err, unix.ENOENT) {
					return err
				}
				continue
			}
			if len(input.Include) > 0 && !matchesAny(input.Include, name) {
				continue
			}
			file, err := source.Read(name)
			if errors.Is(err, ErrTooLarge) {
				result.Truncated = true
				continue
			}
			if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EXDEV) || errors.Is(err, ErrPath) {
				continue
			}
			if err != nil {
				return err
			}
			scanned += len(file.Content)
			if bytes.ContainsRune(file.Content, 0) || !utf8.Valid(file.Content) {
				continue
			}
			found := SearchFile{Path: name, Matches: make([]SearchMatch, 0)}
			for row, line := range strings.Split(string(file.Content), "\n") {
				if len(line) > 8192 {
					result.Truncated = true
					continue
				}
				for _, span := range matcher.FindAllStringIndex(line, -1) {
					if span[0] == span[1] || (input.WholeWord && !wholeWord(line, span[0], span[1])) {
						continue
					}
					found.Matches = append(found.Matches, SearchMatch{
						Line: row + 1, Character: utf8.RuneCountInString(line[:span[0]]) + 1,
						Length: utf8.RuneCountInString(line[span[0]:span[1]]), LineText: line,
					})
					matches++
					if matches >= limit {
						result.Truncated = true
						break
					}
				}
				if matches >= limit {
					break
				}
			}
			if len(found.Matches) > 0 {
				result.Results = append(result.Results, found)
			}
		}
		return nil
	}
	err = visit("", 0)
	return result, err
}
