package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"io"
	"slices"
	"strings"
	"testing"
)

func testFrame(t *testing.T, red uint8) []byte {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	picture.Set(7, 7, color.NRGBA{R: red, A: 255})
	var data bytes.Buffer
	if err := png.Encode(&data, picture); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestCompactRecordingShortensOnlyExactRepeatedFrames(t *testing.T) {
	first, changed := testFrame(t, 1), testFrame(t, 2)
	var input, output bytes.Buffer
	// Seven minutes of model/inspection delay must not become seven minutes
	// of playback. Even a one-pixel error/focus change must remain in sequence.
	input.Write(bytes.Repeat(first, 7*60*15))
	input.Write(changed)
	input.Write(bytes.Repeat(first, 60*15))
	var positions []int64
	err := compactRecording(&input, &output, func(position int64) error {
		positions = append(positions, position)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := append(bytes.Repeat(first, maximumStillFrames), changed...)
	expected = append(expected, bytes.Repeat(first, maximumStillFrames)...)
	if !bytes.Equal(output.Bytes(), expected) {
		t.Fatal("compaction removed a changed frame or retained idle duplicates")
	}
	for index, position := range positions {
		if position != int64(index+1)*1000/recordingFPS {
			t.Fatal("presentation positions depend on wall time or encoder lag", positions)
		}
	}
	if positions[len(positions)-1] >= 1000 {
		t.Fatal("idle intervals were not condensed", positions)
	}
}

func TestCompactRecordingKeepsEveryChangingFrame(t *testing.T) {
	var input, output bytes.Buffer
	for index := range 120 {
		input.Write(testFrame(t, uint8(index)))
	}
	expected := bytes.Clone(input.Bytes())
	if err := compactRecording(&input, &output, func(int64) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), expected) {
		t.Fatal("motion or a changing loading/error state was shortened")
	}
}

func TestCompactRecordingRejectsIncompleteOrUnboundedInput(t *testing.T) {
	oversized := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 8)...)
	binary.BigEndian.PutUint32(oversized[8:], maximumPNGBytes+1)
	for _, input := range [][]byte{
		[]byte("not a PNG"),
		testFrame(t, 1)[:20],
		oversized,
	} {
		var output bytes.Buffer
		if err := compactRecording(bytes.NewReader(input), &output, func(int64) error { return nil }); err == nil {
			t.Fatal("invalid input was accepted")
		}
		if output.Len() != 0 {
			t.Fatal("partial frame was published")
		}
	}
	if err := compactRecording(bytes.NewReader(testFrame(t, 1)), io.Discard, func(int64) error {
		return io.ErrClosedPipe
	}); err == nil {
		t.Fatal("missing timeline publication was accepted")
	}
}

func TestRecordingArgumentsKeepPresentationFramesAndVersionProbe(t *testing.T) {
	if args, recording := recordingArguments([]string{"-version"}); recording || !slices.Equal(args, []string{"-version"}) {
		t.Fatal("upstream executable probe was changed", args)
	}
	args, recording := recordingArguments([]string{
		"-avioflags", "direct", "-fflags", "nobuffer", "-framerate", "15", "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
		"-an", "-vcodec", "vp9", "-f", "webm", "-vf", "crop=1280:720:0:0", "pipe:1",
	})
	if !recording || slices.Contains(args, "nobuffer") || slices.Contains(args, "direct") || args[len(args)-1] != "pipe:1" ||
		!slices.Contains(args, "/tmp/factory-recording-progress.txt") ||
		!strings.Contains(strings.Join(args, " "), "scale=1280:720") {
		t.Fatal("recording arguments shifted frames or lost the bounded canvas/output", args)
	}
}
