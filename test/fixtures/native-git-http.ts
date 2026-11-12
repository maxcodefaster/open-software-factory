// An owned real Git CGI remote behind the native fixture's existing TLS ingress.
// It is not a Factory repository adapter or a replacement for live Project setup.
export function nativeGitHTTP(directory: string) {
  const username = "owned-native-git";
  const password = crypto.randomUUID();
  const prefix = `/owned-native-git-${crypto.randomUUID()}`;
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const observations = { authenticated: 0, pushes: 0, redirects: 0 };
  return {
    username,
    password,
    prefix,
    observations,
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${prefix}/`)) return null;
      if (request.headers.get("authorization") !== authorization)
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="owned-native-git"' },
        });
      const path = url.pathname.slice(prefix.length);
      if (/^\/redirect\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
        observations.redirects++;
        return new Response(null, {
          status: 302,
          headers: {
            location: `${prefix}${path.replace("/redirect.git/", "/remote.git/")}${url.search}`,
          },
        });
      }
      if (!/^\/remote\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(path))
        return new Response(null, { status: 404 });
      observations.authenticated++;
      if (request.method === "POST" && path.endsWith("/git-receive-pack")) observations.pushes++;
      const body = new Uint8Array(await request.arrayBuffer());
      const child = Bun.spawn(["git", "http-backend"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PROJECT_ROOT: directory,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: username,
          REQUEST_METHOD: request.method,
          PATH_INFO: path,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          SERVER_PROTOCOL: "HTTP/1.1",
          GATEWAY_INTERFACE: "CGI/1.1",
        },
      });
      child.stdin.write(body);
      child.stdin.end();
      const [bytes, , exit] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
        child.exited,
      ]);
      if (exit) throw new Error("Owned Git HTTP backend failed");
      const output = Buffer.from(bytes);
      let end = output.indexOf("\r\n\r\n");
      let separator = 4;
      if (end < 0) {
        end = output.indexOf("\n\n");
        separator = 2;
      }
      if (end < 0) throw new Error("Owned Git HTTP backend headers missing");
      const headers = new Headers();
      let status = 200;
      for (const line of output.subarray(0, end).toString().split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 1) throw new Error("Owned Git HTTP backend header malformed");
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers.append(name, value);
      }
      return new Response(output.subarray(end + separator), { status, headers });
    },
  };
}
