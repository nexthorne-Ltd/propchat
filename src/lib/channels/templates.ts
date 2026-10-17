/**
 * Message template helpers that both the server and the ticket screen use
 * (kept free of Node imports so the browser bundle can include them).
 */

/** Counts the {{n}} placeholders a template body needs filled. */
export function templateParamCount(body: string): number {
  const nums = Array.from(body.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** The template body with its placeholders filled, for the transcript. */
export function renderTemplate(body: string, params: string[] = []): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n) => params[Number(n) - 1] || all);
}
