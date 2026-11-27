// Fixed Factory tools from the native read-only image volume. This selects a
// shipped ABI, never a Project executable, copied payload or runtime provider.
export function nativeToolShell(tool: "bun" | "node") {
  const directory = tool === "bun" ? "opencode" : "language-tools";
  return `unset BUN_OPTIONS BUN_INSPECT NODE_OPTIONS NODE_PATH LD_PRELOAD LD_AUDIT
factory_runtime=
for factory_libc in glibc musl; do
  factory_candidate="/opt/factory-tools/opt/factory/${directory}/$factory_libc/${tool}"
  ${
    tool === "node"
      ? 'export LD_LIBRARY_PATH="/opt/factory-tools/opt/factory/language-tools/$factory_libc/lib"'
      : "unset LD_LIBRARY_PATH"
  }
  if "$factory_candidate" --version >/dev/null 2>&1; then
    factory_runtime="$factory_candidate"
    break
  fi
done
if [ -z "$factory_runtime" ]; then
  printf '%s\\n' 'Factory ${tool} requires the read-only tools image and a supported glibc or musl Project runtime.' >&2
  exit 1
fi`;
}
