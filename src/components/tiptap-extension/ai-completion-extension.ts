import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { EditorView } from "@tiptap/pm/view"

import { getCompletion, isConfigured } from "@/lib/azure-openai"

export interface AiCompletionState {
  suggestion: string | null
  anchor: number | null
  loading: boolean
  error: string | null
  // Monotonic counter; bumped by `triggerAiCompletion` so the plugin's
  // view() can detect a manual fire request from inside update().
  trigger: number
}

interface AiCompletionMeta {
  suggestion?: string | null
  anchor?: number | null
  loading?: boolean
  error?: string | null
  forceFire?: boolean
}

export const aiCompletionPluginKey = new PluginKey<AiCompletionState>("aiCompletion")

const DEBOUNCE_MS = 500
const MIN_CONTEXT_CHARS = 3
const MAX_CONTEXT_CHARS = 2000

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    aiCompletion: {
      triggerAiCompletion: () => ReturnType
      acceptAiCompletion: () => ReturnType
      dismissAiCompletion: () => ReturnType
    }
  }
}

function readContext(
  view: EditorView,
): { prefix: string; anchor: number } | null {
  const { state } = view
  const sel = state.selection
  if (!sel.empty) return null
  const $from = sel.$from
  if ($from.parentOffset !== $from.parent.content.size) return null
  const before = state.doc.textBetween(0, sel.head, "\n", "\n")
  if (before.trim().length < MIN_CONTEXT_CHARS) return null
  return { prefix: before.slice(-MAX_CONTEXT_CHARS), anchor: sel.head }
}

function buildDecorations(
  state: AiCompletionState,
  docState: import("@tiptap/pm/state").EditorState,
): DecorationSet {
  if (state.suggestion && state.anchor != null) {
    const widget = Decoration.widget(
      state.anchor,
      () => {
        const span = document.createElement("span")
        span.className = "ai-completion-ghost"
        span.textContent = state.suggestion ?? ""
        span.setAttribute("contenteditable", "false")
        return span
      },
      { side: 1, ignoreSelection: true, key: `ghost:${state.suggestion}` },
    )
    return DecorationSet.create(docState.doc, [widget])
  }
  if (state.loading && docState.selection.empty) {
    const widget = Decoration.widget(
      docState.selection.head,
      () => {
        const span = document.createElement("span")
        span.className = "ai-completion-loading"
        span.textContent = "…"
        span.setAttribute("contenteditable", "false")
        return span
      },
      { side: 1, ignoreSelection: true, key: "loading" },
    )
    return DecorationSet.create(docState.doc, [widget])
  }
  return DecorationSet.empty
}

export const AiCompletion = Extension.create({
  name: "aiCompletion",

  addCommands() {
    return {
      triggerAiCompletion:
        () =>
        ({ editor }) => {
          editor.view.dispatch(
            editor.state.tr.setMeta(aiCompletionPluginKey, {
              forceFire: true,
              error: null,
            } as AiCompletionMeta),
          )
          return true
        },
      acceptAiCompletion:
        () =>
        ({ editor }) => {
          const value = aiCompletionPluginKey.getState(editor.state)
          if (!value?.suggestion || value.anchor == null) return false
          const tr = editor.state.tr
          tr.insertText(value.suggestion, value.anchor)
          tr.setMeta(aiCompletionPluginKey, {
            suggestion: null,
            anchor: null,
            loading: false,
            error: null,
          } as AiCompletionMeta)
          editor.view.dispatch(tr)
          return true
        },
      dismissAiCompletion:
        () =>
        ({ editor }) => {
          const value = aiCompletionPluginKey.getState(editor.state)
          if (!value?.suggestion && !value?.error) return false
          editor.view.dispatch(
            editor.state.tr.setMeta(aiCompletionPluginKey, {
              suggestion: null,
              anchor: null,
              loading: false,
              error: null,
            } as AiCompletionMeta),
          )
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.acceptAiCompletion(),
      Escape: () => this.editor.commands.dismissAiCompletion(),
      "Mod-Space": () => this.editor.commands.triggerAiCompletion(),
      "Ctrl-Space": () => this.editor.commands.triggerAiCompletion(),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<AiCompletionState>({
        key: aiCompletionPluginKey,
        state: {
          init: (): AiCompletionState => ({
            suggestion: null,
            anchor: null,
            loading: false,
            error: null,
            trigger: 0,
          }),
          apply(tr, value): AiCompletionState {
            const meta = tr.getMeta(aiCompletionPluginKey) as
              | AiCompletionMeta
              | undefined
            if (meta) {
              return {
                suggestion:
                  meta.suggestion === undefined ? value.suggestion : meta.suggestion,
                anchor: meta.anchor === undefined ? value.anchor : meta.anchor,
                loading: meta.loading === undefined ? value.loading : meta.loading,
                error: meta.error === undefined ? value.error : meta.error,
                trigger: meta.forceFire ? value.trigger + 1 : value.trigger,
              }
            }
            if (tr.docChanged) {
              return {
                suggestion: null,
                anchor: null,
                loading: value.loading,
                error: null,
                trigger: value.trigger,
              }
            }
            return value
          },
        },
        props: {
          decorations(state) {
            const value = aiCompletionPluginKey.getState(state)
            if (!value) return null
            return buildDecorations(value, state)
          },
        },
        view() {
          let timer: ReturnType<typeof setTimeout> | null = null
          let abort: AbortController | null = null
          let seq = 0
          let lastTrigger = 0

          const cancelInflight = () => {
            if (timer) {
              clearTimeout(timer)
              timer = null
            }
            if (abort) {
              abort.abort()
              abort = null
            }
          }

          const fire = (view: EditorView) => {
            const ctx = readContext(view)
            if (!ctx) {
              view.dispatch(
                view.state.tr.setMeta(aiCompletionPluginKey, {
                  loading: false,
                  error:
                    "Place the cursor at the end of a paragraph and try again.",
                } as AiCompletionMeta),
              )
              return
            }
            const mySeq = ++seq
            const ctrl = new AbortController()
            abort = ctrl
            view.dispatch(
              view.state.tr.setMeta(aiCompletionPluginKey, {
                loading: true,
                error: null,
              } as AiCompletionMeta),
            )
            getCompletion(ctx.prefix, { signal: ctrl.signal })
              .then((text) => {
                if (mySeq !== seq) return
                const sel = view.state.selection
                // Relaxed check: cursor still empty + still at end of a text
                // block. Strict anchor equality dropped completions any time
                // the user typed during the round trip.
                const stillAtEnd =
                  sel.empty &&
                  sel.$from.parentOffset === sel.$from.parent.content.size
                if (!stillAtEnd || !text) {
                  view.dispatch(
                    view.state.tr.setMeta(aiCompletionPluginKey, {
                      loading: false,
                    } as AiCompletionMeta),
                  )
                  return
                }
                view.dispatch(
                  view.state.tr.setMeta(aiCompletionPluginKey, {
                    suggestion: text,
                    anchor: sel.head,
                    loading: false,
                    error: null,
                  } as AiCompletionMeta),
                )
              })
              .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === "AbortError") return
                const message = err instanceof Error ? err.message : String(err)
                console.warn("ai-completion request failed", err)
                view.dispatch(
                  view.state.tr.setMeta(aiCompletionPluginKey, {
                    loading: false,
                    error: message,
                  } as AiCompletionMeta),
                )
              })
          }

          const schedule = (view: EditorView, immediate = false) => {
            cancelInflight()
            if (!isConfigured()) {
              view.dispatch(
                view.state.tr.setMeta(aiCompletionPluginKey, {
                  loading: false,
                  error: immediate
                    ? "Azure OpenAI is not configured. Click the ✨ button to add your endpoint, key, and deployment."
                    : null,
                } as AiCompletionMeta),
              )
              return
            }
            if (immediate) {
              fire(view)
              return
            }
            timer = setTimeout(() => fire(view), DEBOUNCE_MS)
          }

          return {
            update(view, prevState) {
              const value = aiCompletionPluginKey.getState(view.state)
              if (value && value.trigger > lastTrigger) {
                lastTrigger = value.trigger
                schedule(view, true)
                return
              }

              const docChanged = !view.state.doc.eq(prevState.doc)
              const selChanged = !view.state.selection.eq(prevState.selection)
              if (docChanged) {
                schedule(view)
                return
              }
              if (selChanged) {
                if (value?.suggestion) {
                  view.dispatch(
                    view.state.tr.setMeta(aiCompletionPluginKey, {
                      suggestion: null,
                      anchor: null,
                      loading: false,
                    } as AiCompletionMeta),
                  )
                }
                cancelInflight()
              }
            },
            destroy() {
              cancelInflight()
            },
          }
        },
      }),
    ]
  },
})

export default AiCompletion
