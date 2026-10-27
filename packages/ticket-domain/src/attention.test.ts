import { expect, test } from "bun:test";
import { mentionedPeople, mentionText, receivesAttention } from "./attention";

const contributor = { id: "contributor", develop: false, manage: false };
const developer = { id: "developer", develop: true, manage: false };
const peer = { id: "peer", develop: true, manage: false };

test("responsibility prefers one eligible human, not a new permission or execution identity", () => {
  expect(receivesAttention({ viewer: developer, responsible: peer, capability: "develop" })).toBe(
    false,
  );
  expect(receivesAttention({ viewer: peer, responsible: peer, capability: "develop" })).toBe(true);
  expect(
    receivesAttention({ viewer: contributor, responsible: contributor, capability: "develop" }),
  ).toBe(false);
  expect(
    receivesAttention({ viewer: developer, responsible: contributor, capability: "develop" }),
  ).toBe(true);
  expect(receivesAttention({ viewer: contributor, capability: "contribute" })).toBe(true);
  expect(receivesAttention({ viewer: developer, capability: "manage" })).toBe(false);
});

test("personal addressees and feedback authors retain their exact authority", () => {
  expect(
    receivesAttention({
      viewer: developer,
      responsible: developer,
      capability: "develop",
      addressedTo: peer.id,
    }),
  ).toBe(false);
  expect(
    receivesAttention({
      viewer: contributor,
      responsible: contributor,
      capability: "develop",
      authorID: contributor.id,
    }),
  ).toBe(true);
});

test("mentions bind identities, deduplicate, escape labels and ignore literal examples", () => {
  const person = { id: "10000000-0000-4000-8000-000000000001", name: "Lee [Product]" };
  const token = mentionText(person);
  expect(token).toBe(`[@Lee  Product](factory-person:${person.id})`);
  expect(mentionedPeople(`${token} ${token}`)).toEqual([person.id]);
  expect(mentionedPeople(`\`${token}\`\n\`\`\`md\n${token}\n\`\`\``)).toEqual([]);
  expect(mentionedPeople(`\\${token}`)).toEqual([]);
  expect(mentionedPeople("[@Lee](javascript:alert(1)) @Lee")).toEqual([]);
});
