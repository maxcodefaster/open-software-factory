package skills

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/trust"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

func installNativeSkills(ctx context.Context, assignment protocol.Assignment, data string) error {
	if err := workspacefiles.ValidateActorSourceIdentity("/var/lib/factory/source"); err != nil {
		return errors.New("skill installation requires the trusted native control PID1")
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || strings.TrimSpace(string(uid)) != assignment.NativeActorUID() {
		return errors.New("skill installation native Actor identity changed")
	}
	// Main protects these mounts before Work admission. Installation must never
	// create, chown, chmod or repair a missing/unprotected volume on demand.
	for path, mode := range map[string]uint32{
		trust.BootstrapStateDirectory: 0700,
		nativeSkillsControlDirectory:  0755,
	} {
		var info unix.Stat_t
		if unix.Lstat(path, &info) != nil || info.Mode != unix.S_IFDIR|mode ||
			info.Uid != 0 || info.Gid != 0 {
			return errors.New("skill installation native control volume is not protected")
		}
	}
	// Immutable control-image tools only, never the separate Work tools mount.
	for _, path := range []string{nativeSkillsBun, nativeSkillsInstaller} {
		var info unix.Stat_t
		if unix.Lstat(path, &info) != nil || info.Mode&unix.S_IFMT != unix.S_IFREG ||
			info.Uid != 0 || info.Gid != 0 || info.Mode&0022 != 0 || info.Nlink != 1 ||
			(path == nativeSkillsBun && info.Mode&0111 == 0) {
			return errors.New("skill installation trusted control tool is unavailable")
		}
	}
	for _, path := range []string{nativeSkillsControlDirectory, trust.BootstrapStateDirectory, filepath.Dir(nativeSkillsBun), filepath.Dir(nativeSkillsInstaller)} {
		for ; ; path = filepath.Dir(path) {
			var info unix.Stat_t
			if unix.Lstat(path, &info) != nil || info.Mode&unix.S_IFMT != unix.S_IFDIR ||
				info.Uid != 0 || info.Gid != 0 || info.Mode&0022 != 0 {
				return errors.New("skill installation trusted control path is not protected")
			}
			if path == "/" {
				break
			}
		}
	}
	return runNativeSkills(ctx, data)
}
