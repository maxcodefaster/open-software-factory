package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

// Keep the pinned encoder unchanged. This fixed adapter limits its worker
// threads inside the existing one-CPU browser container and measures the actual
// child process. Measurements live only in the ephemeral browser filesystem.
func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		for index := 0; index+1 < len(args); index++ {
			if args[index] == "-vf" {
				// Keep a single 720p canvas through the allowed viewport cases.
				// Fit and center the entire frame rather than losing controls.
				args[index+1] = "scale=1280:720:force_original_aspect_ratio=decrease:eval=frame,pad=1280:720:(ow-iw)/2:(oh-ih)/2:eval=frame,setsar=1"
			}
		}
		// Puppeteer's final argument is its pipe output. Encoder options belong
		// before that output, decoder/filter options before the input.
		args = append([]string{"-threads", "1", "-filter_threads", "1"}, args...)
		last := args[len(args)-1]
		args = append(args[:len(args)-1], "-threads", "1", "-stats_period", "0.1",
			"-progress", "/tmp/factory-recording-progress.txt", last)
	}
	command := exec.Command("/usr/bin/ffmpeg", args...)
	command.Env = []string{"PATH=/usr/bin:/bin", "HOME=/tmp"}
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	started := time.Now()
	err := command.Run()
	status := 1
	if command.ProcessState != nil {
		status = command.ProcessState.ExitCode()
		if len(os.Args) > 1 {
			peak := int64(0)
			if usage, ok := command.ProcessState.SysUsage().(*syscall.Rusage); ok {
				peak = usage.Maxrss
				if runtime.GOOS == "linux" {
					peak *= 1024
				}
			}
			data, _ := json.Marshal(map[string]any{
				"encoderUserMicros":   command.ProcessState.UserTime().Microseconds(),
				"encoderSystemMicros": command.ProcessState.SystemTime().Microseconds(),
				"encoderPeakRSSBytes": peak, "encoderWallMs": time.Since(started).Milliseconds(),
				"encoderExitCode": status,
			})
			_ = os.WriteFile("/tmp/factory-recording-usage.json", data, 0600)
		}
	}
	if err == nil {
		status = 0
	}
	if status < 0 {
		status = 1
	}
	os.Exit(status)
}
