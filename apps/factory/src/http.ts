// Keep Bun's ordinary 128 MiB HTTP ingress ceiling explicit. Individual
// protocols can be narrower; a multimodal model history is not a text paste.
export const maximumHTTPRequestBytes = 128 * 1024 * 1024;

export function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, headers ? { status, headers } : { status });
}

export function sameFactoryOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expected = new URL(process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000").origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
