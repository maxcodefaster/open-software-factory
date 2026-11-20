// One corpus for the feature parser and native publication checks.
export function attachmentReferenceCases(id: string) {
  const url = `/api/attachments/${id}`;
  return [
    { content: url, ids: [id] },
    { content: `![Reference](${url})\n[Again](${url})`, ids: [id] },
    { content: `/API/ATTACHMENTS/${id.toUpperCase()}/previews/0`, ids: [id] },
    { content: `${url}\n${url}\t${url}\r${url} "${url}" '${url}' ${url}\\`, ids: [id] },
    { content: `${url}partial ${url}?query ${url}#fragment ${url}-extra`, ids: [] },
    { content: `\`${url}\``, ids: [] },
    { content: `\`\`\`md\n${url}\n\`\`\``, ids: [] },
    { content: `~~~md\n${url}\n~~~`, ids: [] },
    { content: `\`\`\`md\n${url}\n\`\`\`\n${url}`, ids: [id] },
    { content: "", ids: [] },
  ];
}
