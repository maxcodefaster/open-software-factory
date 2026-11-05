import { expect, test } from "bun:test";
import { serverCall } from "./result";

test("server calls retain command status without replaying lost or old-deployment requests", async () => {
  await expect(
    serverCall(
      Promise.resolve({
        ok: false,
        status: 409,
        message: "Name is already used.",
      }),
    ),
  ).rejects.toMatchObject({ status: 409, message: "Name is already used." });
  await expect(
    serverCall(
      Promise.resolve({
        ok: false,
        status: 409,
        message: "The implementation command identity was reused with different input",
      }),
    ),
  ).rejects.toMatchObject({
    status: 409,
    message: "This request no longer matches what was saved. Reload and try again.",
  });
  let calls = 0;
  const lost = () => {
    calls++;
    return Promise.reject(new Error("transport lost"));
  };
  await expect(serverCall(lost())).rejects.toThrow("transport lost");
  expect(calls).toBe(1);
  const old = Object.assign(new Error("removed function"), { unknownFunction: true });
  await expect(serverCall(Promise.reject(old))).rejects.toMatchObject({
    status: 409,
    message:
      "Factory was updated. Reload before continuing. An unconfirmed command is not repeated.",
  });
});

test("an expired session reads as a sign-in instruction, not a generic failure", async () => {
  const expired = Object.assign(new Error("Server function call failed with status 401"), {
    status: 401,
  });
  await expect(serverCall(Promise.reject(expired))).rejects.toMatchObject({
    status: 401,
    message: "Your session expired. Reload the page and sign in again; your drafts are retained.",
  });
  const outage = Object.assign(new Error("Server function call failed with status 500"), {
    status: 500,
  });
  await expect(serverCall(Promise.reject(outage))).rejects.toMatchObject({
    message: "Factory could not complete that action. Try again.",
  });
});
