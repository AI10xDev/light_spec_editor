import TurndownService from "turndown"
// turndown-plugin-gfm has no published types.
// @ts-expect-error -- shipped without type definitions
import { gfm } from "turndown-plugin-gfm"

let cached: TurndownService | null = null

function getService(): TurndownService {
  if (cached) return cached
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  })
  td.use(gfm)
  // Tiptap renders task list items as <li data-type="taskItem"> with a
  // checkbox <label><input type="checkbox">…</label>. Turndown's default rules
  // bury the checkbox state inside the label markup; rewrite to GFM "- [x]".
  td.addRule("tiptapTaskItem", {
    filter: (node) =>
      node.nodeName === "LI" && node.getAttribute("data-type") === "taskItem",
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const input = el.querySelector("input[type='checkbox']")
      const checked = input?.getAttribute("checked") !== null && input?.getAttribute("checked") !== "false"
      const text = (el.querySelector("div, p, span")?.textContent ?? el.textContent ?? "").trim()
      return `- [${checked ? "x" : " "}] ${text}\n`
    },
  })
  cached = td
  return cached
}

export function htmlToMarkdown(html: string): string {
  return getService().turndown(html).trim() + "\n"
}
