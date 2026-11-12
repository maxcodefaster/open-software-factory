package connector

import (
	"context"
	"errors"
	"os"
	"strings"
)

// Network credentials never enter a process that reads Project Git config,
// attributes, filters or hooks. Only this new Parent-private bare repository
// receives them. It is not retained Source and contains no Project configuration.
func nativeRemoteRepository(ctx context.Context) (string, func(), error) {
	directory, err := os.MkdirTemp("", "factory-native-remote-*")
	if err != nil {
		return "", nil, errors.New("private native Git directory is unavailable")
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	if err := hardenedGitCommand(ctx, "", nil, "init", "--bare", "--", directory).Run(); err != nil {
		cleanup()
		return "", nil, errors.New("private native Git repository could not be initialized")
	}
	if err := hardenedGitCommand(ctx, directory, nil, "config", "http.followRedirects", "false").Run(); err != nil {
		cleanup()
		return "", nil, errors.New("private native Git destination fence could not be configured")
	}
	return directory, cleanup, nil
}

// Transfer one exact commit and its reachable objects, never config, refs,
// credentials or working files. The process touching Source runs as its normal
// development user. The Parent only interprets pack data in its private repo.
func transferNativeCommit(ctx context.Context, workspace, private, sha string, intoSource bool) error {
	if !validCommitSHA(sha) {
		return errors.New("native Git transfer requires an exact commit")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pack := workspaceGitCommand(ctx, workspace, "pack-objects", "--stdout", "--revs")
	index := hardenedGitCommand(ctx, private, nil, "index-pack", "--stdin", "--strict")
	if intoSource {
		pack = hardenedGitCommand(ctx, private, nil, "pack-objects", "--stdout", "--revs")
		index = workspaceGitCommand(ctx, workspace, "index-pack", "--stdin", "--strict")
	}
	pack.Stdin = strings.NewReader(sha + "\n")
	reader, writer, err := os.Pipe()
	if err != nil {
		return errors.New("native Git transfer pipe is unavailable")
	}
	defer reader.Close()
	defer writer.Close()
	pack.Stdout = writer
	index.Stdin = reader
	if err := index.Start(); err != nil {
		return errors.New("native Git object import could not start")
	}
	if err := pack.Start(); err != nil {
		_ = writer.Close()
		cancel()
		_ = index.Wait()
		return errors.New("native Git object export could not start")
	}
	_ = reader.Close()
	_ = writer.Close()
	exported := pack.Wait()
	if exported != nil {
		cancel()
	}
	imported := index.Wait()
	if exported != nil || imported != nil {
		return errors.New("native Git object transfer was not confirmed")
	}
	return nil
}

func fetchNativeIntegration(ctx context.Context, workspace string, message Message) error {
	private, cleanup, err := nativeRemoteRepository(ctx)
	if err != nil {
		return err
	}
	defer cleanup()
	environment, cleanCredentials, err := commitGitEnvironment(message)
	if err != nil {
		return errors.New("private native Git credentials are unavailable")
	}
	defer cleanCredentials()
	fetch := hardenedGitCommand(ctx, private, nil, "fetch", "--no-tags", "--", message.RepositoryURL, message.MergeParentSHA)
	fetch.Env = environment
	if err := fetch.Run(); err != nil {
		return errors.New("integration source could not be fetched")
	}
	return transferNativeCommit(ctx, workspace, private, message.MergeParentSHA, true)
}

func pushNativeCommit(ctx context.Context, workspace string, message Message) (string, error) {
	private, cleanup, err := nativeRemoteRepository(ctx)
	if err != nil {
		return "", err
	}
	defer cleanup()
	if err := transferNativeCommit(ctx, workspace, private, message.CommitSHA, false); err != nil {
		return "", err
	}
	if err := hardenedGitCommand(ctx, private, nil, "update-ref", "HEAD", message.CommitSHA).Run(); err != nil {
		return "", errors.New("private native Git commit could not be selected")
	}
	// Reuse the ordinary exact-HEAD/remote observation and push owner, now operating
	// only on the private repository. No Project-controlled config reaches root.
	return pushCommit(context.WithValue(ctx, nativeCommitGitKey{}, false), private, message)
}
