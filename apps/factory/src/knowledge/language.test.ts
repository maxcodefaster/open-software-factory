import { expect, test } from "bun:test";
import { documentationLanguage } from "./language";

const german = `Astro-/Preact-Plattform für ACME-Seiten, Anwendungen und Formulare. Die Produktion ist die aktuelle fachliche und visuelle Referenz. Die unter .references/ bereitgestellten alten Quellen sind Implementierungsreferenzen, aber keine Zielarchitektur. Vor jeder Änderung gilt AGENTS.md. Bei Portal-, Contentful-, Shell-, Modul- oder visueller Paritätsarbeit muss zusätzlich PORTAL_GUARD.md vollständig gelesen werden. Der Einstieg ist mise run setup, danach wird ein Issue ausgewählt.`;
const english = `This platform is for pages, applications and forms. The production site is the current reference and it is not a target architecture. Before any change, read AGENTS.md. For portal work, the guard file must be read in full, and the setup is run with mise before an issue is selected from the board that the team uses.`;

test("detects clearly German and English documentation", () => {
  expect(documentationLanguage([german])).toBe("de");
  expect(documentationLanguage([english])).toBe("en");
});

test("stays silent for short samples and ignores code", () => {
  expect(documentationLanguage(["Hallo Welt"])).toBeUndefined();
  expect(
    documentationLanguage([
      `\`\`\`\nconst the and is not with for of to in on = 1\n\`\`\`\n${german}`,
    ]),
  ).toBe("de");
});
