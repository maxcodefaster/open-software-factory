import { resolve } from "node:path";

function encodingQuality(header: string | null, name: string) {
  const values = new Map(
    (header ?? "").split(",").map((entry) => {
      const [encoding, ...options] = entry.trim().toLowerCase().split(";");
      const quality = options.find((option) => option.trim().startsWith("q="));
      const parsed = quality ? Number(quality.trim().slice(2)) : 1;
      return [encoding, Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0];
    }),
  );
  return values.get(name) ?? values.get("*") ?? (name === "identity" ? 1 : 0);
}

export function createStaticAssets(
  directory: string,
  renderPage: (request: Request) => Promise<Response>,
) {
  const root = resolve(directory);
  return async (request: Request): Promise<Response> => {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 404 });
    }
    if (path.split("/").some((part) => part.startsWith(".")) || /\0|\.(?:br|gz)$/.test(path))
      return new Response(null, { status: 404 });
    if (path === "/") return renderPage(request);
    const filePath = resolve(root, `.${path}`);
    if (!filePath.startsWith(`${root}/`)) return new Response(null, { status: 404 });
    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      // Only client navigation falls back to the shell, never an outdated asset or API.
      if (
        !/^\/(?:api|internal|_server|assets|src)(?:\/|$)/.test(path) &&
        !path.split("/").at(-1)?.includes(".") &&
        request.headers.get("accept")?.includes("text/html")
      ) {
        return renderPage(request);
      } else return new Response(null, { status: 404 });
    }
    const immutable = /\/assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i.test(filePath);
    const headers = new Headers({
      "content-type": file.type || "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      vary: "Accept-Encoding",
      "x-content-type-options": "nosniff",
    });
    const accepted = request.headers.get("accept-encoding");
    const candidates = [
      { name: "br", suffix: ".br" },
      { name: "gzip", suffix: ".gz" },
    ].sort((a, b) => encodingQuality(accepted, b.name) - encodingQuality(accepted, a.name));
    let encoding = "identity";
    if (!request.headers.has("range"))
      for (const candidate of candidates) {
        if (encodingQuality(accepted, candidate.name) === 0) continue;
        const compressed = Bun.file(`${filePath}${candidate.suffix}`);
        if (!(await compressed.exists())) continue;
        file = compressed;
        encoding = candidate.name;
        headers.set("content-encoding", encoding);
        break;
      }
    if (encoding === "identity" && encodingQuality(accepted, "identity") === 0)
      return new Response(null, { status: 406, headers });
    const etag = `"${file.size.toString(16)}-${file.lastModified.toString(16)}-${encoding}"`;
    if (immutable) {
      headers.set("etag", etag);
      if (
        request.headers
          .get("if-none-match")
          ?.split(",")
          .some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag)
      )
        return new Response(null, { status: 304, headers });
    }
    headers.set("content-length", String(file.size));
    return new Response(request.method === "HEAD" ? null : file, { headers });
  };
}
