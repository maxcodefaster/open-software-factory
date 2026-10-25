import { expect, test } from "bun:test";
import { serverCall } from "./result";

test("server calls retain command status without replaying lost or old-deployment requests", async () => {
  await expect(
    serverCall(
      Promise.resolve({
        ok: false,
        status: 409,
        message: "Changed input",
      }),
    ),
  ).rejects.toMatchObject({ status: 409, message: "Changed input" });
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
