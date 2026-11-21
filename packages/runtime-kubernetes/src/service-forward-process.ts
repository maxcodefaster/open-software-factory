import { kubernetesCommand, kubernetesConnectionEnvironment } from "./config";
import { serviceForwardTimeoutMS } from "./service-forward";
// Fixed trusted service connections only. IPC disconnection owns cleanup after Factory death.
export async function runServiceForward(args: readonly string[]) {
  const [namespace, podName] = args;
  const namespacePattern = /^factory-editor-[a-f0-9]{32}$/;
  const podPattern = /^editor-[1-9][0-9]*$/;
  if (
    !process.send ||
    !process.connected ||
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
      "0:4400",
    ]),
    {
      env: kubernetesConnectionEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
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
  const deadline = setTimeout(stop, serviceForwardTimeoutMS);
  let output = "";
  const reader = forward.stdout.getReader();
  if (!process.connected) stop();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output = (output + new TextDecoder().decode(chunk.value)).slice(-4096);
    const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (match && !stopping && process.connected) {
      clearTimeout(deadline);
      process.send?.({ port: Number(match[1]) }, (error: Error | null) => {
        if (error) stop();
      });
      output = "";
    }
  }
  await forward.exited;
  process.exit(stopping ? 0 : 1);
}
