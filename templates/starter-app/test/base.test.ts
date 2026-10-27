import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedAsset } from "../src/base.ts";

test("Preview asset and native function URLs retain queries without duplicate mounts", () => {
  const prefix = "/runtime/01994a7d-0000-7000-8000-000000000001/preview/app";
  assert.equal(scopedAsset("./assets/entry.js", prefix), `${prefix}/assets/entry.js`);
  assert.equal(scopedAsset("/_server/id?args=[]", prefix), `${prefix}/_server/id?args=[]`);
  assert.equal(scopedAsset(`${prefix}/@vite/client?v=1`, prefix), `${prefix}/@vite/client?v=1`);
  assert.equal(scopedAsset("/assets/chunk.js", ""), "/assets/chunk.js");
  assert.equal(scopedAsset("https://cdn.example/asset.js", prefix), "https://cdn.example/asset.js");
});
