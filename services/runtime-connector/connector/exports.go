package connector

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"os/exec"

	"github.com/gorilla/websocket"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/artifacts"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/browser"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/commands"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/containerfiles"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/control"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/gitops"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/inputstop"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/language"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/processes"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/skills"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/terminal"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/trust"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/writergate"
)

// Exported API re-exports preserving compatibility for cmd/* and callers.

const (
	AssignmentVersion                 = protocol.AssignmentVersion
	ConnectorProtocol                 = protocol.ConnectorProtocol
	OpenCodeArtifactsRoot             = artifacts.OpenCodeArtifactsRoot
	OpenCodeArtifactsManifestMaxBytes = artifacts.OpenCodeArtifactsManifestMaxBytes
)

type (
	Assignment           = protocol.Assignment
	Channel              = protocol.Channel
	Process              = protocol.Process
	Message              = protocol.Message
	CommandRequest       = protocol.CommandRequest
	CommandRead          = protocol.CommandRead
	CommandView          = protocol.CommandView
	ContainerFileRequest = containerfiles.Request
	ContainerFileView    = containerfiles.View
	ContainerFileListing = containerfiles.Listing
)

func ReadAssignment(path string) (Assignment, error) {
	return protocol.ReadAssignment(path)
}

func ProtectProcess() error                      { return procutil.ProtectProcess() }
func PrepareAssignedProcess(command *exec.Cmd)   { procutil.PrepareAssignedProcess(command) }
func StopAssignedProcess(command *exec.Cmd)      { procutil.StopAssignedProcess(command) }
func TerminateAssignedProcess(command *exec.Cmd) { procutil.TerminateAssignedProcess(command) }

func ValidateRuntimeValues(values map[string]string) error {
	return procutil.ValidateRuntimeValues(values)
}

func OpenCodeArtifactsManifest(root string) ([]byte, error) {
	return artifacts.OpenCodeArtifactsManifest(root)
}

func ReadOpenCodeArtifactsManifest(root string) (manifest []byte, digest string, err error) {
	return artifacts.ReadOpenCodeArtifactsManifest(root)
}

func OpenCodeArtifactsSize(manifest []byte) (int64, error) {
	return artifacts.OpenCodeArtifactsSize(manifest)
}

func VerifyOpenCodeArtifacts(root string, manifest []byte, libc string) error {
	return artifacts.VerifyOpenCodeArtifacts(root, manifest, libc)
}

func ResetOpenCodeArtifacts(root string) error {
	return artifacts.ResetOpenCodeArtifacts(root)
}

func RunNativeInputStopWorker() error {
	return inputstop.RunWorker()
}

func RunBrowserWorker(ctx context.Context) error {
	return browser.RunBrowserWorker(ctx)
}

func RunBrowserAppProxy(ctx context.Context) error {
	return browser.RunBrowserAppProxy(ctx)
}

func RunNativeBrowserGateway(ctx context.Context) error {
	return browser.RunNativeBrowserGateway(ctx)
}

// Package-internal aliases delegating to extracted internal/* packages.

const (
	maxMessageBytes          = protocol.MaxMessageBytes
	maxControlBytes          = protocol.MaxControlBytes
	maxResponseBytes         = protocol.MaxResponseBytes
	maxResponseCookies       = protocol.MaxResponseCookies
	maxResponseCookieBytes   = protocol.MaxResponseCookieBytes
	maxAppAuthorizationBytes = protocol.MaxAppAuthorizationBytes

	channelReadinessTimeout   = procutil.ChannelReadinessTimeout
	orderedRequestTimeout     = procutil.OrderedRequestTimeout
	gitOperationTimeout       = procutil.GitOperationTimeout
	gitRemoteTimeout          = procutil.GitRemoteTimeout
	gitCloneTimeout           = procutil.GitCloneTimeout
	browserOpenTimeout        = procutil.BrowserOpenTimeout
	browserCallTimeout        = procutil.BrowserCallTimeout
	controlHandshakeTimeout   = procutil.ControlHandshakeTimeout
	controlWriteTimeout       = procutil.ControlWriteTimeout
	controlPingInterval       = procutil.ControlPingInterval
	controlReadTimeout        = procutil.ControlReadTimeout
	controlReadQueueLimit     = procutil.ControlReadQueueLimit
	controlReconnectMin       = procutil.ControlReconnectMin
	controlReconnectMax       = procutil.ControlReconnectMax
	parentOperationQueueLimit = procutil.ParentOperationQueueLimit

	nativeProjectTrustDirectory    = trust.ProjectTrustDirectory
	nativeProjectTrustFile         = trust.ProjectTrustFile
	nativeBootstrapTrustProjection = trust.BootstrapTrustProjection
	nativeBootstrapStateDirectory  = trust.BootstrapStateDirectory
	nativeBootstrapTrustLimit      = trust.BootstrapTrustLimit
	nativeSkillsControlDirectory   = skills.ControlDirectory
)

type (
	startupMeasurement  = procutil.StartupMeasurement
	environmentVariable = procutil.EnvironmentVariable
	environmentBundle   = procutil.EnvironmentBundle
	runtimeEnvironment  = procutil.RuntimeEnvironment

	nativeProjectWriterGate = writergate.Gate
	nativeProjectTemplate   = trust.ProjectTemplate

	nativeInputStop             = inputstop.Assignment
	nativeInputStopWorkerResult = inputstop.WorkerResult
	nativeInputStopResult       = inputstop.Result

	containerFileManager = containerfiles.Manager

	controlConnection   = control.Connection
	reconnectBackoff    = control.Backoff
	parentSourceStreams = control.ParentSourceStreams
	parentSourceFence   = control.ParentSourceFence

	commandManager = commands.Manager

	terminalManager      = terminal.Manager
	terminalControl      = terminal.TerminalControl
	terminalCommandInput = terminal.CommandInput

	languageManager = language.Manager

	processManager = processes.Manager

	browserRuntimeRequest    = browser.RuntimeRequest
	browserToolCall          = browser.ToolCall
	browserInspectionContext = browser.InspectionContext
)

var (
	commandIDPattern    = procutil.CommandIDPattern
	identityPattern     = protocol.IdentityPattern
	channelPattern      = protocol.ChannelPattern
	browserImagePattern = protocol.BrowserImagePattern
)

func errorText(err error) string { return protocol.ErrorText(err) }

func validateTarget(value string) error { return protocol.ValidateTarget(value) }

func validAppAuthorization(value string) bool { return protocol.ValidAppAuthorization(value) }

func validResponseCookies(cookies []string) bool { return protocol.ValidResponseCookies(cookies) }

func flattenHeaders(headers http.Header) map[string]string { return protocol.FlattenHeaders(headers) }

func ownedCommand(ctx context.Context, name string, arguments ...string) *exec.Cmd {
	return procutil.OwnedCommand(ctx, name, arguments...)
}

func listenPrivateUnix(path string) (*net.UnixListener, error) {
	return procutil.ListenPrivateUnix(path)
}

func removeStaleSocket(path string) error {
	return procutil.RemoveStaleSocket(path)
}

func resetStartupTimings() { procutil.ResetStartupTimings() }

func startupPhase(phase string) func() { return procutil.StartupPhase(phase) }

func measureStartupPhase(phase string, output io.Writer) func() {
	return procutil.MeasureStartupPhase(phase, output)
}

func validateEnvironmentName(name string) bool {
	return procutil.ValidateEnvironmentName(name)
}

func retryRuntimeEnvironmentRead(err error) bool {
	return procutil.RetryRuntimeEnvironmentRead(err)
}

func assignedEnvironment(base []string, values map[string]string) []string {
	return procutil.AssignedEnvironment(base, values)
}

func nativeBootstrapCertificates(bundle []byte) bool {
	return trust.ValidCertificates(bundle)
}

func nativeBootstrapTrust(directory string, native []byte, factory string, prepare bool) (string, error) {
	return trust.PrepareBootstrapTrust(directory, native, factory, prepare)
}

func verifyNativeProjectTemplate(project, selectedPath string, expected *nativeProjectTemplate) error {
	return trust.VerifyProjectTemplate(project, selectedPath, expected)
}

func copyChildExecutable(ctx context.Context, containerID, source, destination string) error {
	return artifacts.CopyChildExecutable(ctx, containerID, source, destination)
}

func prepareChildPermissions(ctx context.Context, containerID, connectorPath, assignmentPath string) error {
	return artifacts.PrepareChildPermissions(ctx, containerID, connectorPath, assignmentPath)
}

func newContainerFileManager(root string) (*containerFileManager, error) {
	return containerfiles.NewManager(root)
}

func dialControl(ctx context.Context, assignment Assignment, role string, token string) (*controlConnection, error) {
	return control.Dial(ctx, assignment, role, token)
}

func newControlConnection(conn *websocket.Conn) *controlConnection {
	return control.NewConnection(conn)
}

func controlTLSConfig() (*tls.Config, error) {
	return control.TLSConfig()
}

func parentChannels(assignment Assignment) []Channel {
	return control.ParentChannels(assignment)
}

func newParentSourceStreams(handler http.Handler) *parentSourceStreams {
	return control.NewParentSourceStreams(handler)
}

func newCommandManager(ctx context.Context, assignment Assignment, send func(Message) error) *commandManager {
	return commands.NewManager(ctx, assignment, send)
}

func newTerminalManager(ctx context.Context, assignment Assignment, send func(Message) error) *terminalManager {
	return terminal.NewManager(ctx, assignment, send)
}

func newLanguageManager(ctx context.Context, assignment Assignment, send func(Message) error) *languageManager {
	return language.NewManager(ctx, assignment, send)
}

func newProcessManager(ctx context.Context, assignment Assignment, output io.Writer) *processManager {
	return processes.NewManager(ctx, assignment, output)
}

func installAdmittedSkills(ctx context.Context, assignment Assignment, data string) error {
	return skills.InstallAdmittedSkills(ctx, assignment, data)
}

func hardenedGitCommand(ctx context.Context, workspace string, config []string, arguments ...string) *exec.Cmd {
	return gitops.HardenedGitCommand(ctx, workspace, config, arguments...)
}

func workspaceGitCommand(ctx context.Context, workspace string, arguments ...string) *exec.Cmd {
	return gitops.WorkspaceGitCommand(ctx, workspace, arguments...)
}

func gitOutput(ctx context.Context, workspace string, arguments ...string) (string, error) {
	return gitops.GitOutput(ctx, workspace, arguments...)
}

func prepareCommit(ctx context.Context, workspace string, message Message) (string, error) {
	return gitops.PrepareCommit(ctx, workspace, message)
}

func pushCommit(ctx context.Context, workspace string, message Message) (string, error) {
	return gitops.PushCommit(ctx, workspace, message)
}

func checkoutProject(ctx context.Context, assignment Assignment) error {
	return gitops.CheckoutProject(ctx, assignment)
}

func personalGit(ctx context.Context, assignment Assignment, message Message) (string, error) {
	return gitops.PersonalGit(ctx, assignment, message)
}

func personalGitCommand(ctx context.Context, workspace string, args ...string) (string, error) {
	return gitops.PersonalGitCommand(ctx, workspace, args...)
}

func ensureTrackedWorkspaceOwnership(ctx context.Context, workspace string) error {
	return gitops.EnsureTrackedWorkspaceOwnership(ctx, workspace)
}

func validCommitSHA(value string) bool {
	return gitops.ValidCommitSHA(value)
}

func decodeBrowserInspectionRequest(message Message, assignment Assignment) (browserRuntimeRequest, string, error) {
	return browser.DecodeInspectionRequest(message, assignment)
}

func sameBrowserScope(left, right browserRuntimeRequest) bool {
	return browser.SameScope(left, right)
}
