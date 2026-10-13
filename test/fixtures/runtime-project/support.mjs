import { createServer } from "node:http";
import { chownSync } from "node:fs";

chownSync("/workspace/data", 1000, 1000);

createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("support-ready");
}).listen(4100, "0.0.0.0");
