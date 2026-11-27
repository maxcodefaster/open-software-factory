package trust

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"
	"unicode/utf8"
)

type ProjectTemplate struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// VerifyProjectTemplate verifies the first Source import for an Actor matches
// the configuration admitted before native Create. Later edits cannot change
// that ActorTemplate, but also must not prevent the original Actor resuming its
// saved checkout. Isolated execution owners acquire their configuration separately.
func VerifyProjectTemplate(project, selectedPath string, expected *ProjectTemplate) error {
	if expected == nil {
		return nil
	}
	digest, err := hex.DecodeString(expected.SHA256)
	if !fs.ValidPath(expected.Path) || len(expected.Path) > 500 ||
		strings.ContainsAny(expected.Path, "\\:\x00") || expected.Path != selectedPath ||
		err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != expected.SHA256 {
		return errors.New("native Project ActorTemplate identity is invalid")
	}
	root, err := os.OpenRoot(project)
	if err != nil {
		return errors.New("native Project Source is unavailable")
	}
	defer root.Close()
	info, err := root.Lstat(expected.Path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return errors.New("imported Project ActorTemplate is missing or unsupported")
	}
	file, err := root.Open(expected.Path)
	if err != nil {
		return errors.New("imported Project ActorTemplate is unavailable")
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil || len(content) > 64<<10 || !utf8.Valid(content) {
		return errors.New("imported Project ActorTemplate content is invalid")
	}
	actual := sha256.Sum256(content)
	if hex.EncodeToString(actual[:]) != expected.SHA256 {
		return errors.New("imported Project ActorTemplate differs from admitted configuration")
	}
	return nil
}
