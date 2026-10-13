import { expect, test } from "bun:test";
import { deliveryViewSchema } from "./api-contracts";

test.each([28, "28"])("Delivery reads PR number %j from the PostgreSQL projection", (value) => {
  expect(deliveryViewSchema.parse({ pullRequestNumber: value }).pullRequestNumber).toBe(28);
});

test.each([undefined, null])("Delivery permits no PR yet: %j", (value) => {
  expect(deliveryViewSchema.parse({ pullRequestNumber: value }).pullRequestNumber).toBeUndefined();
});

test.each(["", " ", "not-a-number", "1.5", "-1", "9007199254740993", 1.5, -1])(
  "Delivery rejects an invalid PR number: %j",
  (value) => {
    expect(deliveryViewSchema.safeParse({ pullRequestNumber: value }).success).toBe(false);
  },
);
