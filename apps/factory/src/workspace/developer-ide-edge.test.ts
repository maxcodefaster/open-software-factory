import { expect, test } from "bun:test";
import { createDeveloperIDEEdge } from "./developer-ide-edge";

test("the authenticated Editor edge admits native Theia Socket.IO and keeps origin/path fences", async () => {
  const userID = "abdabd34-6496-40f1-afbf-86187708037c";
  const factoryOrigin = "http://127.0.0.1:3000";
  const edge = createDeveloperIDEEdge(
    { client: async () => [{ id: "fixture-session" }] } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[0],
    {
      get: async () => ({ epoch: 1, state: "ready" }),
      connection: async () => "http://127.0.0.1:12345",
    } as unknown as Parameters<typeof createDeveloperIDEEdge>[1],
    {} as Parameters<typeof createDeveloperIDEEdge>[2],
    factoryOrigin,
    { revokeEditor() {} } as unknown as Parameters<typeof createDeveloperIDEEdge>[4],
  );
  const issued = await edge.issue(userID, "fixture-session", false);
  const redeemed = await edge.route(new Request(issued));
  const root = new URL(redeemed.headers.get("location")!);
  const cookie = redeemed.headers.get("set-cookie")!.split(";")[0]!;
  const socketURL = new URL("socket.io/?EIO=4&transport=websocket", root);
  const request = (url = socketURL, origin = root.origin, credential = cookie) =>
    new Request(url, {
      headers: { origin, cookie: credential },
    });
  const data = await edge.socketData(request());
  expect(data instanceof Response).toBe(false);
  if (data instanceof Response) throw new Error(`Native Socket.IO was refused: ${data.status}`);
  expect(data.backendURL).toBe("ws://127.0.0.1:12345/socket.io/?EIO=4&transport=websocket");
  expect(data.userID).toBe(userID);
  expect(data.epoch).toBe(1);
  const foreign = await edge.socketData(request(socketURL, "https://foreign.invalid"));
  expect(foreign instanceof Response && foreign.status).toBe(403);
  const unauthorized = await edge.socketData(request(socketURL, root.origin, ""));
  expect(unauthorized instanceof Response && unauthorized.status).toBe(401);
  const other = await edge.socketData(request(new URL("arbitrary-socket", root)));
  expect(other instanceof Response && other.status).toBe(404);
});
