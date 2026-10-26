package connector

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// An open prompt is not work. Retain foreground jobs, shell children, changed
// executables and active shell builtins. An unreadable observation is busy.
func terminalBusy(session *terminalSession) bool {
	if session.command == nil || session.command.Process == nil || session.file == nil || session.executable == nil {
		return true
	}
	pid := session.command.Process.Pid
	root := fmt.Sprintf("/proc/%d", pid)
	data, err := os.ReadFile(root + "/stat")
	if err != nil {
		return true
	}
	end := strings.LastIndex(string(data), ") ")
	if end < 0 {
		return true
	}
	fields := strings.Fields(string(data)[end+2:])
	if len(fields) < 13 {
		return true
	}
	user, userErr := strconv.ParseUint(fields[11], 10, 64)
	system, systemErr := strconv.ParseUint(fields[12], 10, 64)
	if userErr != nil || systemErr != nil {
		return true
	}
	cpu := user + system
	changed := cpu != session.cpu
	session.cpu = cpu
	group, groupErr := strconv.Atoi(fields[2])
	foreground, terminalErr := unix.IoctlGetInt(int(session.file.Fd()), unix.TIOCGPGRP)
	if groupErr != nil || terminalErr != nil || foreground != group {
		return true
	}
	children, err := os.ReadFile(fmt.Sprintf("%s/task/%d/children", root, pid))
	if err != nil || len(strings.Fields(string(children))) != 0 {
		return true
	}
	executable, err := os.Stat(root + "/exe")
	return err != nil || !os.SameFile(session.executable, executable) || changed
}
