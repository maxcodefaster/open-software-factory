//go:build !linux

package terminal

// Native Linux owns terminal activity qualification. Other hosts fail closed.
func terminalBusy(session *terminalSession) bool { return true }
