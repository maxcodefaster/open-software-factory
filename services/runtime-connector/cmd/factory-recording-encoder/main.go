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
	args, recording := recordingArguments(os.Args[1:])
	command := exec.Command("/usr/bin/ffmpeg", args...)
	command.Env = []string{"PATH=/usr/bin:/bin", "HOME=/tmp"}
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	started := time.Now()
	var err error
	if recording {
		var inputErr error
		input, pipeErr := command.StdinPipe()
		if pipeErr != nil || publishPosition(0) != nil {
			os.Exit(1)
		}
		if err = command.Start(); err == nil {
			drained := make(chan error, 1)
			go func() {
				failure := compactRecording(os.Stdin, input, publishPosition)
				_ = input.Close()
				if failure != nil {
					_ = command.Process.Kill()
				}
				drained <- failure
			}()
			err = command.Wait()
			// A failed child may end before consuming input. Do not wait on a
			// blocked upstream pipe after FFmpeg has already exited.
			if err == nil {
				inputErr = <-drained
			}
		}
		if inputErr != nil {
			err = inputErr
		}
	} else {
		command.Stdin = os.Stdin
		err = command.Run()
	}
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
	if status < 0 || (err != nil && status == 0) {
		status = 1
	}
	os.Exit(status)
}
