package connector

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// The pinned CLI chooses the container folder (including /workspaces/project
// when workspaceFolder is omitted). Its path is authoritative only after the
// inspected primary proves that it is within the same writable canonical
// checkout, not a volume, a different tree or an unmounted image directory.
func validateNativeWorkspaceFolder(container inspectedContainer, assignment Assignment, remote string) (string, error) {
	if !filepath.IsAbs(remote) || filepath.Clean(remote) != remote || remote == "/" {
		return "", errors.New("Dev Containers CLI returned an invalid remote workspace")
	}
	checkout, err := os.Stat(assignment.WorkspaceFolder)
	if err != nil || !checkout.IsDir() {
		return "", errors.New("canonical Source checkout identity is unavailable")
	}
	selected := -1
	destinations := map[string]bool{}
	for index, mount := range container.Mounts {
		if !filepath.IsAbs(mount.Destination) || filepath.Clean(mount.Destination) != mount.Destination ||
			(remote != mount.Destination && !strings.HasPrefix(remote, strings.TrimSuffix(mount.Destination, "/")+"/")) {
			continue
		}
		if destinations[mount.Destination] {
			return "", errors.New("remote workspace has ambiguous Source mounts")
		}
		destinations[mount.Destination] = true
		// The closest enclosing mount owns cwd. A nested volume or bind must
		// not hide the canonical Source mount and pass validation through it.
		if selected == -1 || len(mount.Destination) > len(container.Mounts[selected].Destination) {
			selected = index
		}
	}
	if selected == -1 {
		return "", errors.New("remote workspace has no confirmed canonical Source bind mount")
	}
	mount := container.Mounts[selected]
	if mount.Type != "bind" || !mount.RW {
		return "", errors.New("remote workspace must use the writable canonical Source bind mount")
	}
	source, err := os.Stat(mount.Source)
	if err != nil || !source.IsDir() || !os.SameFile(checkout, source) {
		return "", errors.New("remote workspace does not mount the canonical Source checkout")
	}
	// workspaceFolder may select an ordinary directory below the repository
	// mount. Prove each component in Source before using it as container cwd;
	// a symlink could resolve differently inside the container's filesystem.
	relative, err := filepath.Rel(mount.Destination, remote)
	if err != nil {
		return "", errors.New("remote workspace is outside its Source mount")
	}
	directory := assignment.WorkspaceFolder
	if relative != "." {
		for _, component := range strings.Split(relative, string(filepath.Separator)) {
			directory = filepath.Join(directory, component)
			entry, err := os.Lstat(directory)
			if err != nil || !entry.IsDir() {
				return "", errors.New("remote workspace is not a confirmed Source directory")
			}
		}
	}
	return mount.Destination, nil
}

func effectiveChildAssignment(assignment Assignment, result devcontainerResult) Assignment {
	child := assignment
	child.WorkspaceFolder = result.RemoteWorkspaceFolder
	child.RemoteWorkspaceFolder = result.RemoteWorkspaceFolder
	child.CheckoutFolder = result.checkoutFolder
	return child
}
