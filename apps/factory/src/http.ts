export function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, headers ? { status, headers } : { status });
}

export function sameFactoryOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expectedOrigin = process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000";
  return new URL(origin).origin === expectedOrigin;
}
