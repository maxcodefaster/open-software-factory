package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"strconv"
)

const recordingFPS = 15
const maximumStillFrames = 3
const maximumPNGBytes = 8 << 20
const positionPath = "/tmp/factory-recording-position.txt"

// Puppeteer submits the same PNG repeatedly to represent elapsed time. Bound
// only those byte-identical runs before decoding/encoding them. Every changed
// frame stays in order at the original rate, including tiny text/focus changes.
// The published counter is the next presentation position, not FFmpeg's
// potentially delayed output progress and not elapsed model-thinking time.
func compactRecording(input io.Reader, output io.Writer, publish func(int64) error) error {
	reader := bufio.NewReaderSize(input, 64<<10)
	var previous []byte
	var frames int64
	repeated := 0
	for {
		frame, err := readPNG(reader)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if !bytes.Equal(frame, previous) {
			previous = frame
			repeated = 0
		}
		repeated++
		if repeated > maximumStillFrames {
			continue
		}
		if _, err := io.Copy(output, bytes.NewReader(frame)); err != nil {
			return err
		}
		frames++
		if err := publish(frames * 1000 / recordingFPS); err != nil {
			return err
		}
	}
}

func readPNG(reader io.Reader) ([]byte, error) {
	var signature [8]byte
	if _, err := io.ReadFull(reader, signature[:]); err != nil {
		return nil, err
	}
	if string(signature[:]) != "\x89PNG\r\n\x1a\n" {
		return nil, errors.New("recording input is not PNG")
	}
	frame := append([]byte(nil), signature[:]...)
	for {
		var header [8]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return nil, io.ErrUnexpectedEOF
		}
		size := int64(binary.BigEndian.Uint32(header[:4])) + 4 // payload + CRC
		if size > maximumPNGBytes || int64(len(frame))+8+size > maximumPNGBytes {
			return nil, errors.New("recording PNG exceeds its bound")
		}
		start := len(frame)
		frame = append(frame, header[:]...)
		frame = append(frame, make([]byte, int(size))...)
		if _, err := io.ReadFull(reader, frame[start+8:]); err != nil {
			return nil, io.ErrUnexpectedEOF
		}
		if string(header[4:]) == "IEND" {
			if size != 4 {
				return nil, errors.New("invalid recording PNG end")
			}
			return frame, nil
		}
	}
}

func publishPosition(position int64) error {
	if err := os.WriteFile(positionPath+".tmp", []byte(strconv.FormatInt(position, 10)), 0600); err != nil {
		return err
	}
	return os.Rename(positionPath+".tmp", positionPath)
}

func recordingArguments(arguments []string) ([]string, bool) {
	args := append([]string(nil), arguments...)
	recording := false
	for index := 0; index+1 < len(args); index++ {
		if args[index] == "-f" && args[index+1] == "image2pipe" {
			recording = true
		}
	}
	if !recording {
		return args, false
	}
	filtered := make([]string, 0, len(args)+8)
	for index := 0; index < len(args); index++ {
		// The input is already bounded and streamed. Probe-buffer bypass can
		// consume initial PNG headers/frames, shifting every chapter position.
		if index+1 < len(args) && ((args[index] == "-fflags" && args[index+1] == "nobuffer") ||
			(args[index] == "-avioflags" && args[index+1] == "direct")) {
			index++
			continue
		}
		if args[index] == "-vf" && index+1 < len(args) {
			filtered = append(filtered, "-vf",
				"scale=1280:720:force_original_aspect_ratio=decrease:eval=frame,pad=1280:720:(ow-iw)/2:(oh-ih)/2:eval=frame,setsar=1")
			index++
			continue
		}
		filtered = append(filtered, args[index])
	}
	args = append([]string{"-threads", "1", "-filter_threads", "1"}, filtered...)
	last := args[len(args)-1]
	args = append(args[:len(args)-1], "-threads", "1", "-stats_period", "0.1",
		"-progress", "/tmp/factory-recording-progress.txt", last)
	return args, true
}
