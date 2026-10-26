//go:build !linux

package connector

// Native Linux owns terminal activity qualification. Other hosts fail closed.
func terminalBusy(session *terminalSession) bool { return true }
