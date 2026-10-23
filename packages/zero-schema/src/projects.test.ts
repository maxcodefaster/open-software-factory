import { expect, test } from "bun:test";
import { desktopBackgroundKeys } from "../../interface-domain/src/background";
import { projectBackgroundValidator } from "./projects";

test("Project backgrounds accept only a Project identity and curated artwork", () => {
  const projectId = crypto.randomUUID();
  const validate = projectBackgroundValidator["~standard"].validate;
  for (const desktopBackgroundKey of desktopBackgroundKeys) {
    expect(validate({ projectId, desktopBackgroundKey })).toEqual({
      value: { projectId, desktopBackgroundKey },
    });
  }
  for (const desktopBackgroundKey of [
    "https://example.invalid/painting.jpg",
    "/art/custom.jpg",
    "custom",
    null,
    undefined,
  ]) {
    expect(validate({ projectId, desktopBackgroundKey })).toHaveProperty("issues");
  }
  expect(
    validate({ projectId: "", desktopBackgroundKey: desktopBackgroundKeys[0] }),
  ).toHaveProperty("issues");
});
