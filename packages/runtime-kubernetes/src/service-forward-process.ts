import { kubernetesCommand } from "./config";
// Fixed trusted service connections only. IPC disconnection owns cleanup after Factory death.
export async function runServiceForward(role: "source" | "editor", args: readonly string[]) {
  const [namespace, podName] = args;
  const namespacePattern =
    role === "source" ? /^factory-workspace-[a-f0-9]{12}$/ : /^factory-editor-[a-f0-9]{32}$/;
  const podPattern = role === "source" ? /^source-[1-9][0-9]*$/ : /^editor-[1-9][0-9]*$/;
  if (
    !process.send ||
    !namespace ||
    !podName ||
    !namespacePattern.test(namespace) ||
    !podPattern.test(podName)
  )
    process.exit(1);
  const forward = Bun.spawn(
    kubernetesCommand([
      "port-forward",
      "--address",
      "127.0.0.1",
      "-n",
      namespace,
      `pod/${podName}`,
      role === "source" ? "0:4600" : "0:4400",
    ]),
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    forward.kill("SIGKILL");
    void forward.exited.finally(() => process.exit(0));
  };
  process.once("disconnect", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const deadline = setTimeout(stop, 10_000);
  let output = "";
  const reader = forward.stdout.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output = (output + new TextDecoder().decode(chunk.value)).slice(-4096);
    const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (match) {
      clearTimeout(deadline);
      process.send?.({ port: Number(match[1]) });
      output = "";
    }
  }
  await forward.exited;
  process.exit(stopping ? 0 : 1);
}
