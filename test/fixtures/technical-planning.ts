import type { TechnicalDesignContent } from "../../packages/requirement-domain/src/technical-design";

export const planningProduct = {
  summary:
    "Export the invoices for a selected billing period as one CSV file. Keep the current invoice permissions and make empty periods explicit.",
  acceptanceCriteria: [
    "Export includes invoice numbers, issue dates and totals for the selected billing period.",
    "An empty period explains that there are no invoices and does not download a file.",
    "A person without invoice access cannot create or download an export.",
  ],
  nonGoals: ["No scheduled exports or new billing permissions."],
};

export const planningDesign: TechnicalDesignContent = {
  context:
    "The invoice list already resolves the selected billing period and checks account access. The invoice store returns records in issue-date order. Keep those existing boundaries.",
  proposedChanges:
    "Add an authenticated **export command** beside the existing invoice reads. It reuses the account-access check, selects invoices for the requested period and writes a CSV response.\n\nThe list shows an empty-period message when the command returns no records. It starts the download only after a successful response.",
  decisions: [
    "Generate the CSV in the authenticated command. A browser-only export would duplicate access and formatting rules.",
    "Reuse the selected billing period instead of adding a second date picker.",
  ],
  assumptions: ["Invoice totals already have a canonical decimal representation."],
  risks: ["A failed export must not leave a download link pointing at a partial file."],
  validation: [
    {
      criterion: 1,
      check:
        "Run the export integration test with invoices inside and outside the selected period. Parse the CSV and compare every number, date and total.",
    },
    {
      criterion: 2,
      check:
        "Open an empty billing period in the browser. Export shows the empty message and creates no download.",
    },
    {
      criterion: 3,
      check:
        "Call the export command as a member without invoice access. Expect permission denied and no invoice data.",
    },
  ],
  diagrams: [
    {
      title: "Invoice export boundaries",
      description:
        "The new export command reuses existing access checks and invoice storage. Only the command and CSV response are new.",
      source:
        '@startuml\nleft to right direction\nskinparam backgroundColor transparent\nskinparam shadowing false\nskinparam componentStyle rectangle\ncomponent "Invoice list\\nexisting" as List\ncomponent "Export command\\nnew" as Export\ncomponent "Account access\\nexisting" as Access\ncomponent "Invoice store\\nexisting" as Store\nList --> Export : selected period\nExport --> Access : authorize\nExport --> Store : read invoices\nExport --> List : CSV or empty result\n@enduml',
    },
  ],
};
