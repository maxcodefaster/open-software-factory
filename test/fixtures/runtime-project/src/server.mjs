import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const sourceUrl = new URL("./version.txt", import.meta.url);
const sockets = new Set();

function websocketFrame(value) {
  const payload = Buffer.from(value);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function readClientFrames(socket, initialData) {
  let buffered = initialData;
  return (chunk = Buffer.alloc(0)) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const lengthCode = buffered[1] & 0x7f;
      const headerLength = lengthCode === 126 ? 4 : 2;
      if (lengthCode === 127 || buffered.length < headerLength + 4) return;
      const payloadLength = lengthCode === 126 ? buffered.readUInt16BE(2) : lengthCode;
      if (buffered.length < headerLength + 4 + payloadLength) return;
      const opcode = buffered[0] & 0x0f;
      const mask = buffered.subarray(headerLength, headerLength + 4);
      const payload = buffered.subarray(headerLength + 4, headerLength + 4 + payloadLength);
      const decoded = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      buffered = buffered.subarray(headerLength + 4 + payloadLength);
      if (opcode === 8) return socket.end();
      if (opcode === 1 || opcode === 2) {
        socket.write(websocketFrame(JSON.stringify({ type: "echo", value: decoded.toString() })));
      }
    }
  };
}

const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/__factory_fixture_source") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { version } = JSON.parse(body);
    if (version !== "one" && version !== "two") {
      response.writeHead(400).end();
      return;
    }
    await writeFile(sourceUrl, `${version}\n`);
    response.writeHead(204).end();
    return;
  }
  if (request.url === "/health") {
    const support = await fetch("http://support:4100/").then((result) => result.text());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", support }));
    return;
  }
  if (request.url === "/source") {
    const source = await readFile(sourceUrl, "utf8");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        version: source.trim(),
        digest: createHash("sha256").update(source).digest("hex"),
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const load = crypto.randomUUID();
  response.end(`<!doctype html>
<title>Runtime fixture</title>
<h1>Runtime fixture ready</h1>
<meta name="fixture-load" content="${load}">
<output id="version"></output>
<script>
  const version = document.querySelector("#version");
  const refresh = () => fetch("./source").then((response) => response.json()).then((source) => {
    version.textContent = source.version;
  });
  const socket = new WebSocket(new URL("./ws", location.href.replace("http", "ws")));
  socket.addEventListener("message", (event) => {
    if (JSON.parse(event.data).type === "hot-update") location.reload();
  });
  refresh();
</script>`);
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") return socket.destroy();
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") return socket.destroy();
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
  const readFrames = readClientFrames(socket, head);
  socket.on("data", readFrames);
  readFrames();
});

watch(sourceUrl, async () => {
  const version = (await readFile(sourceUrl, "utf8")).trim();
  const frame = websocketFrame(JSON.stringify({ type: "hot-update", version }));
  for (const socket of sockets) socket.write(frame);
});

server.listen(4300, "0.0.0.0");
