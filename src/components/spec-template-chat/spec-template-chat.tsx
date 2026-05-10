import { useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/react"

import { chatCompletion, type ChatMessage } from "@/lib/azure-openai"

import "./spec-template-chat.css"

const SYSTEM_PROMPT = `You generate ready-to-paste templates for a Feature & Technical Requirements Spec Sheet editor.

Rules:
- Always wrap the template in a single fenced code block: \`\`\`html ... \`\`\`. The content of the block must be valid HTML — paragraphs, headings, lists, tables — that pastes cleanly into a rich-text editor.
- Use <h2> for section titles, <h3> for subsections, <ol> or <ul> for requirement lists, <table> for matrices.
- Use RFC 2119 verbs (MUST, SHOULD, MAY) in requirement bullets where appropriate.
- For fields the author will fill in, use <em>angle-bracket placeholders</em>, e.g. <em>&lt;feature name&gt;</em>.
- Use <code> for technical identifiers (endpoint paths, env vars, types).
- Keep templates concrete: include only the sections typical for that artefact, no filler.
- Outside the code block, write at most one short sentence of context. No preamble, no closing remarks.

Common requests and what to return:
- "feature spec" / "feature requirements": Overview, Goals, Functional Requirements (numbered), Non-Functional Requirements, Acceptance Criteria, Out of Scope, Dependencies, Risks.
- "API endpoint spec": Endpoint, Method, Auth, Request (path/query/headers/body), Response (status codes + body), Errors, Rate Limits, Examples.
- "data model": Entity name, Fields table (name/type/required/description/constraints), Relationships, Indexes.
- "non-functional requirements": Performance, Availability, Security, Observability, Compliance — each as a short list of measurable targets.
- "acceptance criteria" / "test plan": Given/When/Then list.
- "RFC" / "design doc": Context, Problem, Proposal, Alternatives, Tradeoffs, Migration, Rollout.

If the request is ambiguous, pick the most likely template and return it — do not ask clarifying questions.`

interface ChatTurn {
  role: "user" | "assistant"
  content: string
  // Populated for assistant turns; the HTML extracted from the first
  // ```html``` fence so the buttons can copy/insert it directly.
  template?: string | null
  error?: string
}

export interface SpecTemplateChatProps {
  editor: Editor | null
  configured: boolean
  onConfigure: () => void
}

const FENCE_RE = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/

function extractTemplate(text: string): string | null {
  const m = text.match(FENCE_RE)
  return m ? m[1].trim() : null
}

function stripFence(text: string): string {
  const t = extractTemplate(text)
  if (!t) return text.trim()
  return text.replace(FENCE_RE, "").trim()
}

export function SpecTemplateChat({
  editor,
  configured,
  onConfigure,
}: SpecTemplateChatProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, loading])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const send = async () => {
    const trimmed = input.trim()
    if (!trimmed || loading) return
    if (!configured) {
      onConfigure()
      return
    }

    const userTurn: ChatTurn = { role: "user", content: trimmed }
    const next = [...turns, userTurn]
    setTurns(next)
    setInput("")
    setLoading(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...next.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
    ]

    try {
      const reply = await chatCompletion(messages, { signal: ctrl.signal })
      const template = extractTemplate(reply)
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: reply, template },
      ])
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      const msg = err instanceof Error ? err.message : String(err)
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: "", error: msg },
      ])
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const copyTemplate = async (idx: number, html: string) => {
    try {
      await navigator.clipboard.writeText(html)
      setCopied(idx)
      setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1500)
    } catch {
      // Fallback: select-and-copy via a hidden textarea.
      const ta = document.createElement("textarea")
      ta.value = html
      document.body.appendChild(ta)
      ta.select()
      document.execCommand("copy")
      ta.remove()
      setCopied(idx)
      setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1500)
    }
  }

  const insertTemplate = (html: string) => {
    if (!editor) return
    editor.chain().focus().insertContent(html).run()
  }

  const reset = () => {
    abortRef.current?.abort()
    setTurns([])
    setInput("")
    setLoading(false)
  }

  return (
    <section className="spec-chat" aria-label="Spec template chat">
      <header className="spec-chat__header">
        <div>
          <strong>Template assistant</strong>
          <span className="spec-chat__subtitle">
            Ask for any spec section — paste or insert the result directly.
          </span>
        </div>
        <div className="spec-chat__header-actions">
          {turns.length > 0 && (
            <button
              type="button"
              className="simple-editor__btn"
              onClick={reset}
              disabled={loading}
              title="Clear conversation"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      <div className="spec-chat__messages" ref={messagesRef}>
        {turns.length === 0 && (
          <div className="spec-chat__empty">
            <p>Try:</p>
            <ul>
              <li>"feature requirements template"</li>
              <li>"API endpoint spec for POST /users"</li>
              <li>"data model for an order"</li>
              <li>"acceptance criteria using Given/When/Then"</li>
            </ul>
          </div>
        )}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="spec-chat__msg is-user">
              <div className="spec-chat__bubble">{turn.content}</div>
            </div>
          ) : (
            <div key={i} className="spec-chat__msg is-assistant">
              <div className="spec-chat__bubble">
                {turn.error ? (
                  <span className="spec-chat__error">{turn.error}</span>
                ) : (
                  <>
                    {stripFence(turn.content) && (
                      <p className="spec-chat__intro">
                        {stripFence(turn.content)}
                      </p>
                    )}
                    {turn.template ? (
                      <div className="spec-chat__template">
                        <pre>
                          <code>{turn.template}</code>
                        </pre>
                        <div className="spec-chat__template-actions">
                          <button
                            type="button"
                            className="simple-editor__btn is-active"
                            onClick={() =>
                              insertTemplate(turn.template as string)
                            }
                            disabled={!editor}
                          >
                            Insert into editor
                          </button>
                          <button
                            type="button"
                            className="simple-editor__btn"
                            onClick={() =>
                              copyTemplate(i, turn.template as string)
                            }
                          >
                            {copied === i ? "Copied" : "Copy HTML"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      !stripFence(turn.content) && (
                        <span className="spec-chat__error">
                          (Empty response)
                        </span>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          ),
        )}
        {loading && (
          <div className="spec-chat__msg is-assistant">
            <div className="spec-chat__bubble">
              <span className="spec-chat__thinking">Thinking…</span>
            </div>
          </div>
        )}
      </div>

      <form
        className="spec-chat__composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          className="spec-chat__input"
          placeholder={
            configured
              ? "Describe the template you need…"
              : "Configure AI in the editor first ↑"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={loading}
        />
        <button
          type="submit"
          className="simple-editor__btn is-active"
          disabled={loading || !input.trim()}
        >
          {loading ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  )
}

export default SpecTemplateChat

// Keep helper exported for unit testing if we add tests later.
export { extractTemplate, stripFence }

// Re-export the static prompt so tooling/users can inspect it.
export { SYSTEM_PROMPT as SPEC_TEMPLATE_SYSTEM_PROMPT }

