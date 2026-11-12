package workspacefiles

import (
	"bytes"
	"errors"
	"io"
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

func TestMappedSourceReadPreservesAccessTimeAndBoundsMappingsAcrossChunks(t *testing.T) {
	for _, size := range []int{0, 1, SourceChunkBytes - 1, SourceChunkBytes, SourceChunkBytes*2 + 37} {
		file, err := os.CreateTemp(t.TempDir(), "owned-source-")
		if err != nil {
			t.Fatal(err)
		}
		data := bytes.Repeat([]byte{0, 1, 2, 255}, (size+3)/4)[:size]
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := unix.UtimesNanoAt(unix.AT_FDCWD, file.Name(), []unix.Timespec{{Sec: 1790000000, Nsec: 123456788}, {Sec: 1790000000, Nsec: 123456789}}, 0); err != nil {
			t.Fatal(err)
		}
		var before, after unix.Stat_t
		if err := unix.Fstat(int(file.Fd()), &before); err != nil {
			t.Fatal(err)
		}
		fd, err := unix.Open(file.Name(), unix.O_RDONLY|unix.O_NOATIME|unix.O_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		err = writeMappedSource(&output, fd, int64(size))
		unix.Close(fd)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(output.Bytes(), data) {
			t.Fatal("mapped Source bytes differ across chunk boundaries")
		}
		if err := unix.Fstat(int(file.Fd()), &after); err != nil || before.Atim != after.Atim || before.Mtim != after.Mtim || before.Ctim != after.Ctim {
			t.Fatal("mapped read changed original Source timestamps")
		}
		file.Close()
	}
}

type truncatedMappedSource struct{ file *os.File }

func (writer truncatedMappedSource) Write(data []byte) (int, error) {
	if err := writer.file.Truncate(0); err != nil {
		return 0, err
	}
	// Force an actual mapped load after the foreign truncate (SIGBUS on Linux).
	if data[len(data)-1] == 255 {
		return 0, io.ErrUnexpectedEOF
	}
	return len(data), nil
}
func TestMappedSourceForeignTruncateFailsClosedWithoutCrashingService(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "owned-source-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(bytes.Repeat([]byte{255}, 4096)); err != nil {
		t.Fatal(err)
	}
	if err := writeMappedSource(truncatedMappedSource{file}, int(file.Fd()), 4096); !errors.Is(err, ErrConflict) {
		t.Fatalf("foreign truncate did not fail closed: %v", err)
	}
}

type shortMappedSource struct{}

func (shortMappedSource) Write(data []byte) (int, error) { return len(data) - 1, nil }
func TestMappedSourceShortArchiveWriteIsNotAccepted(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "owned-source-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write([]byte("owned")); err != nil {
		t.Fatal(err)
	}
	if err := writeMappedSource(shortMappedSource{}, int(file.Fd()), 5); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short archive write was accepted: %v", err)
	}
}
