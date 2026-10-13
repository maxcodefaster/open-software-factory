import { createServer } from "node:http";

createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ process: "worker", ready: request.url === "/health" }));
}).listen(4310, "0.0.0.0", () => console.log("Worker monitor ready on 4310"));
