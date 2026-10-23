import { expect, test } from "bun:test";
import { reviewRequestBody } from "./http";
import { jpegDimensions } from "./media";

test("review uploads enforce their streaming bound even without Content-Length", async () => {
  let cancelled = false;
  const request = new Request("https://factory.invalid", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  await expect(reviewRequestBody(request, 10)).rejects.toThrow("size limit");
  expect(cancelled).toBe(true);
  expect(
    (
      await reviewRequestBody(
        new Request("https://factory.invalid", { method: "POST", body: "small" }),
        10,
      )
    ).toString(),
  ).toBe("small");
});
test("annotation upload rejects non-JPEG or broken dimension headers", () => {
  expect(jpegDimensions(Buffer.from("<script>not an image</script>"))).toBeNull();
  expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff]))).toBeNull();
});
