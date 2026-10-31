package connector

import (
	"errors"
	"os"
	"path/filepath"
)

// Only the public App assignment and short browser lease use this directory.
// The parent keeps its private session directory at 0700. Both isolated
// consumers run as UID 1000 and receive this child directory read-only.
func writeBrowserConfig(directory, name string, content []byte) error {
	config := filepath.Join(directory, "config")
	if err := os.MkdirAll(config, 0755); err != nil {
		return err
	}
	// The production bootstrap deliberately inherits umask 077. Creation modes
	// alone cannot give the isolated consumers their intended read access.
	if err := os.Chmod(config, 0755); err != nil {
		return err
	}
	file, err := os.CreateTemp(config, "."+name+"-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, written := file.Write(content)
	protected := file.Chmod(0444)
	closed := file.Close()
	if err := errors.Join(written, protected, closed); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(config, name))
}
