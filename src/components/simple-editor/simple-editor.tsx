import { useCallback, useEffect, useRef, useState } from "react"
import { EditorContent, EditorContext, useEditor } from "@tiptap/react"
import type { Editor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { Placeholder } from "@tiptap/extensions"
import { Mention } from "@tiptap/extension-mention"
import { TaskList, TaskItem } from "@tiptap/extension-list"
import { Color, TextStyle } from "@tiptap/extension-text-style"
import { Highlight } from "@tiptap/extension-highlight"
import { Subscript } from "@tiptap/extension-subscript"
import { Superscript } from "@tiptap/extension-superscript"
import { TextAlign } from "@tiptap/extension-text-align"
import { Mathematics } from "@tiptap/extension-mathematics"
import { Typography } from "@tiptap/extension-typography"
import { UniqueID } from "@tiptap/extension-unique-id"
import { Emoji, gitHubEmojis } from "@tiptap/extension-emoji"
import {
  getHierarchicalIndexes,
  TableOfContents,
} from "@tiptap/extension-table-of-contents"
import { Image } from "@tiptap/extension-image"
import { TableKit } from "@/components/tiptap-node/table-node/extensions/table-node-extension"
import { EmojiDropdownMenu } from "@/components/tiptap-ui/emoji-dropdown-menu"
import { MentionDropdownMenu } from "@/components/tiptap-ui/mention-dropdown-menu"
import { SlashDropdownMenu } from "@/components/tiptap-ui/slash-dropdown-menu"

import {
  AiCompletion,
  aiCompletionPluginKey,
  type AiCompletionState,
} from "@/components/tiptap-extension/ai-completion-extension"
import { SpecTemplateChat } from "@/components/spec-template-chat/spec-template-chat"
import {
  clearStoredConfig,
  getConfig,
  isConfigured,
  setStoredConfig,
  testConnection,
  type AzureOpenAIConfig,
  type TestResult,
} from "@/lib/azure-openai"
import { htmlToMarkdown } from "@/lib/html-to-markdown"

import "./simple-editor.css"

export interface SimpleEditorProps {
  initialContent?: string
  placeholder?: string
}

interface EditorDocument {
  id: string
  name: string
  content: string
}

const EMPTY_DOC = "<p></p>"
const OPEN_ACCEPT = ".html,.htm,.md,.markdown,.txt,.json,text/html,text/markdown,text/plain,application/json"

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "html" || ext === "htm") return "text/html"
  if (ext === "md" || ext === "markdown") return "text/markdown"
  if (ext === "json") return "application/json"
  return "text/plain"
}

async function saveTextToFile(suggestedName: string, contents: string): Promise<void> {
  const mime = mimeForName(suggestedName)
  const ext = suggestedName.split(".").pop()?.toLowerCase() ?? "html"
  // File System Access API — Chromium only. Gives a real Save As dialog.
  const w = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string
      types?: { description: string; accept: Record<string, string[]> }[]
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: BlobPart) => Promise<void>
        close: () => Promise<void>
      }>
    }>
  }
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: `${ext.toUpperCase()} file`,
            accept: { [mime]: [`.${ext}`] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(new Blob([contents], { type: mime }))
      await writable.close()
      return
    } catch (err) {
      // AbortError = user cancelled the picker; swallow silently.
      if (err instanceof DOMException && err.name === "AbortError") return
      console.warn("showSaveFilePicker failed, falling back to download", err)
    }
  }
  // Fallback: trigger a browser download.
  const blob = new Blob([contents], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = suggestedName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function fileToHtml(name: string, text: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "html" || ext === "htm") return text
  if (ext === "json") return `<pre><code>${escapeHtml(text)}</code></pre>`
  // md / markdown / txt / unknown — preserve line breaks as paragraphs
  const lines = text.split(/\r?\n/)
  const html = lines.map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("")
  return html || EMPTY_DOC
}

interface ToolbarButtonProps {
  onClick: () => void
  isActive?: boolean
  disabled?: boolean
  label: string
  children: React.ReactNode
}

function ToolbarButton({
  onClick,
  isActive,
  disabled,
  label,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`simple-editor__btn${isActive ? " is-active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

interface TabBarProps {
  documents: EditorDocument[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveMarkdown: () => void
  onRename: (id: string, name: string) => void
  aiConfigured: boolean
  aiLoading: boolean
  onOpenAiSettings: () => void
  onTriggerAi: () => void
}

interface AiSettingsPanelProps {
  onClose: () => void
  onSaved: () => void
}

function AiSettingsPanel({ onClose, onSaved }: AiSettingsPanelProps) {
  const initial = getConfig() ?? ({ endpoint: "", apiKey: "", deployment: "", apiVersion: "2024-10-21" } as AzureOpenAIConfig)
  const [endpoint, setEndpoint] = useState(initial.endpoint)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [deployment, setDeployment] = useState(initial.deployment)
  const [apiVersion, setApiVersion] = useState(initial.apiVersion)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      // Don't auto-close if the click was on the trigger button — its own
      // onClick toggles the panel and we'd race with it.
      if (target.closest("[data-ai-toggle]")) return
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const save = () => {
    setStoredConfig({ endpoint, apiKey, deployment, apiVersion })
    onSaved()
    onClose()
  }

  const clear = () => {
    clearStoredConfig()
    setEndpoint("")
    setApiKey("")
    setDeployment("")
    setApiVersion("2024-10-21")
    setTestResult(null)
    onSaved()
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection({ endpoint, apiKey, deployment, apiVersion })
      setTestResult(result)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="simple-editor__ai-panel" ref={panelRef} role="dialog" aria-label="Azure OpenAI settings">
      <div className="simple-editor__ai-panel-header">
        <div className="simple-editor__ai-panel-title">Azure OpenAI</div>
        <button
          type="button"
          className="simple-editor__tab-close"
          aria-label="Close settings"
          title="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <label className="simple-editor__ai-field">
        <span>Endpoint</span>
        <input
          type="url"
          placeholder="https://my-resource.openai.azure.com"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="simple-editor__ai-field">
        <span>API key</span>
        <input
          type="password"
          placeholder="key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="simple-editor__ai-field">
        <span>Deployment</span>
        <input
          type="text"
          placeholder="gpt-4o-mini"
          value={deployment}
          onChange={(e) => setDeployment(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="simple-editor__ai-field">
        <span>API version</span>
        <input
          type="text"
          placeholder="2024-10-21"
          value={apiVersion}
          onChange={(e) => setApiVersion(e.target.value)}
          spellCheck={false}
        />
      </label>
      <p className="simple-editor__ai-hint">
        Stored locally in this browser. The Azure resource must allow CORS from this origin.
        Type, then pause — Tab to accept, Esc to dismiss.
      </p>
      {testResult && (
        <div
          className={`simple-editor__ai-test-result${testResult.ok ? " is-ok" : " is-fail"}`}
          role="status"
        >
          <div className="simple-editor__ai-test-message">{testResult.message}</div>
          {testResult.url && (
            <code className="simple-editor__ai-test-url" title={testResult.url}>
              {testResult.url}
            </code>
          )}
        </div>
      )}
      <div className="simple-editor__ai-actions">
        <button type="button" className="simple-editor__btn" onClick={clear} disabled={testing}>
          Clear
        </button>
        <button
          type="button"
          className="simple-editor__btn"
          onClick={test}
          disabled={testing || !endpoint || !apiKey || !deployment}
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button type="button" className="simple-editor__btn is-active" onClick={save} disabled={testing}>
          Save
        </button>
      </div>
    </div>
  )
}

interface TabItemProps {
  doc: EditorDocument
  isActive: boolean
  isEditing: boolean
  onSelect: () => void
  onClose: () => void
  onStartEdit: () => void
  onCommitEdit: (name: string) => void
  onCancelEdit: () => void
}

function TabItem({
  doc,
  isActive,
  isEditing,
  onSelect,
  onClose,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
}: TabItemProps) {
  const [draft, setDraft] = useState(doc.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      setDraft(doc.name)
      // Focus + select on next paint so the input is mounted.
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        const dot = doc.name.lastIndexOf(".")
        if (dot > 0) el.setSelectionRange(0, dot)
        else el.select()
      })
    }
  }, [isEditing, doc.name])

  const commit = () => {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === doc.name) onCancelEdit()
    else onCommitEdit(trimmed)
  }

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      className={`simple-editor__tab${isActive ? " is-active" : ""}`}
      onClick={() => !isEditing && onSelect()}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onStartEdit()
      }}
      onKeyDown={(e) => {
        if (isEditing) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect()
        } else if (e.key === "F2") {
          e.preventDefault()
          onStartEdit()
        }
      }}
      title={isEditing ? undefined : `${doc.name} — double-click to rename`}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          className="simple-editor__tab-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              onCancelEdit()
            }
          }}
        />
      ) : (
        <span className="simple-editor__tab-name">{doc.name}</span>
      )}
      <button
        type="button"
        className="simple-editor__tab-close"
        aria-label={`Close ${doc.name}`}
        title="Close"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </div>
  )
}

function TabBar({
  documents,
  activeId,
  onSelect,
  onClose,
  onNew,
  onOpen,
  onSave,
  onSaveMarkdown,
  onRename,
  aiConfigured,
  aiLoading,
  onOpenAiSettings,
  onTriggerAi,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <div className="simple-editor__tabs" role="tablist" aria-label="Open documents">
      <div className="simple-editor__tabs-list">
        {documents.map((doc) => (
          <TabItem
            key={doc.id}
            doc={doc}
            isActive={doc.id === activeId}
            isEditing={editingId === doc.id}
            onSelect={() => onSelect(doc.id)}
            onClose={() => onClose(doc.id)}
            onStartEdit={() => {
              onSelect(doc.id)
              setEditingId(doc.id)
            }}
            onCommitEdit={(name) => {
              onRename(doc.id, name)
              setEditingId(null)
            }}
            onCancelEdit={() => setEditingId(null)}
          />
        ))}
      </div>
      <div className="simple-editor__tabs-actions">
        <button
          type="button"
          data-ai-toggle
          className={`simple-editor__btn${aiConfigured ? " is-active" : ""}`}
          aria-label={aiConfigured ? "Edit AI configuration" : "Configure AI"}
          title={aiConfigured ? "AI: connected — click to edit config" : "AI: not configured"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenAiSettings}
        >
          ✨
        </button>
        {aiConfigured && (
          <button
            type="button"
            className={`simple-editor__btn${aiLoading ? " is-loading" : ""}`}
            aria-label="Suggest completion now (Ctrl+Space)"
            title="Suggest now (Ctrl+Space)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onTriggerAi}
            disabled={aiLoading}
          >
            ⏎
          </button>
        )}
        <button
          type="button"
          className="simple-editor__btn"
          aria-label="Rename current document"
          title="Rename (F2)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEditingId(activeId)}
        >
          ✎
        </button>
        <button
          type="button"
          className="simple-editor__btn"
          aria-label="Save current document"
          title="Save"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSave}
        >
          💾
        </button>
        <button
          type="button"
          className="simple-editor__btn"
          aria-label="Save current document as Markdown"
          title="Save as Markdown"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSaveMarkdown}
        >
          MD
        </button>
        <button
          type="button"
          className="simple-editor__btn"
          aria-label="New document"
          title="New document"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onNew}
        >
          +
        </button>
        <button
          type="button"
          className="simple-editor__btn"
          aria-label="Open file"
          title="Open file"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpen}
        >
          📂
        </button>
      </div>
    </div>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="simple-editor__toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarButton
        label="Bold"
        isActive={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        isActive={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        label="Strike"
        isActive={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <s>S</s>
      </ToolbarButton>
      <ToolbarButton
        label="Underline"
        isActive={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <u>U</u>
      </ToolbarButton>
      <ToolbarButton
        label="Inline code"
        isActive={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        {"</>"}
      </ToolbarButton>
      <ToolbarButton
        label="Subscript"
        isActive={editor.isActive("subscript")}
        onClick={() => editor.chain().focus().toggleSubscript().run()}
      >
        X<sub>2</sub>
      </ToolbarButton>
      <ToolbarButton
        label="Superscript"
        isActive={editor.isActive("superscript")}
        onClick={() => editor.chain().focus().toggleSuperscript().run()}
      >
        X<sup>2</sup>
      </ToolbarButton>
      <ToolbarButton
        label="Highlight"
        isActive={editor.isActive("highlight")}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
      >
        <mark>H</mark>
      </ToolbarButton>

      <span className="simple-editor__sep" aria-hidden />

      <ToolbarButton
        label="Heading 1"
        isActive={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        label="Heading 2"
        isActive={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        label="Paragraph"
        isActive={editor.isActive("paragraph")}
        onClick={() => editor.chain().focus().setParagraph().run()}
      >
        ¶
      </ToolbarButton>

      <span className="simple-editor__sep" aria-hidden />

      <ToolbarButton
        label="Bullet list"
        isActive={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        •
      </ToolbarButton>
      <ToolbarButton
        label="Ordered list"
        isActive={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        label="Blockquote"
        isActive={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </ToolbarButton>
      <ToolbarButton
        label="Task list"
        isActive={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        ☑
      </ToolbarButton>
      <ToolbarButton
        label="Code block"
        isActive={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        {"{}"}
      </ToolbarButton>

      <span className="simple-editor__sep" aria-hidden />

      <ToolbarButton
        label="Align left"
        isActive={editor.isActive({ textAlign: "left" })}
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
      >
        ⯇
      </ToolbarButton>
      <ToolbarButton
        label="Align center"
        isActive={editor.isActive({ textAlign: "center" })}
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
      >
        ≡
      </ToolbarButton>
      <ToolbarButton
        label="Align right"
        isActive={editor.isActive({ textAlign: "right" })}
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
      >
        ⯈
      </ToolbarButton>
      <ToolbarButton
        label="Justify"
        isActive={editor.isActive({ textAlign: "justify" })}
        onClick={() => editor.chain().focus().setTextAlign("justify").run()}
      >
        ☰
      </ToolbarButton>

      <span className="simple-editor__sep" aria-hidden />

      <ToolbarButton
        label="Insert / edit link"
        isActive={editor.isActive("link")}
        onClick={() => {
          const previous = (editor.getAttributes("link").href as string | undefined) ?? ""
          const url = window.prompt("URL (leave empty to remove)", previous)
          if (url === null) return
          if (url === "") {
            editor.chain().focus().extendMarkRange("link").unsetLink().run()
            return
          }
          editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
        }}
      >
        🔗
      </ToolbarButton>
      <ToolbarButton
        label="Insert image"
        onClick={() => {
          const url = window.prompt("Image URL")
          if (!url) return
          editor.chain().focus().setImage({ src: url }).run()
        }}
      >
        🖼
      </ToolbarButton>
      <ToolbarButton
        label="Insert table"
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
      >
        ⊞
      </ToolbarButton>

      <span className="simple-editor__sep" aria-hidden />

      <ToolbarButton
        label="Undo"
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        ↶
      </ToolbarButton>
      <ToolbarButton
        label="Redo"
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      >
        ↷
      </ToolbarButton>
    </div>
  )
}

export function SimpleEditor({
  initialContent = "<h1>Hello</h1><p>Start writing…</p>",
  placeholder = "Start writing…",
}: SimpleEditorProps) {
  const [documents, setDocuments] = useState<EditorDocument[]>(() => [
    { id: makeId(), name: "Untitled", content: initialContent },
  ])
  const [activeId, setActiveId] = useState<string>(() => documents[0]?.id ?? "")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiConfigured, setAiConfigured] = useState(() => isConfigured())
  const [aiStatus, setAiStatus] = useState<AiCompletionState>({
    suggestion: null,
    anchor: null,
    loading: false,
    error: null,
    trigger: 0,
  })

  // Refs so the editor's onUpdate callback always sees current values
  // without needing to recreate the editor instance on every state change.
  const activeIdRef = useRef(activeId)
  const isSwitchingRef = useRef(false)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder }),
      AiCompletion,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Typography,
      Mathematics,
      Emoji.configure({
        emojis: gitHubEmojis.filter((e) => !e.name.includes("regional")),
        forceFallbackImages: true,
      }),
      Mention,
      Image,
      TableKit.configure({ table: { resizable: true, cellMinWidth: 120 } }),
      TableOfContents.configure({ getIndex: getHierarchicalIndexes }),
      UniqueID.configure({
        types: ["heading", "paragraph", "blockquote", "codeBlock", "table", "bulletList", "orderedList", "taskList"],
      }),
    ],
    content: documents[0]?.content ?? EMPTY_DOC,
    editorProps: {
      attributes: { class: "simple-editor__content" },
    },
    onUpdate: ({ editor }) => {
      if (isSwitchingRef.current) return
      const html = editor.getHTML()
      const id = activeIdRef.current
      setDocuments((prev) =>
        prev.map((d) => (d.id === id ? { ...d, content: html } : d)),
      )
    },
    onTransaction: ({ editor }) => {
      const value = aiCompletionPluginKey.getState(editor.state)
      if (value) setAiStatus(value)
    },
  })

  // Load the active document's content into the editor on tab switch.
  useEffect(() => {
    if (!editor) return
    const doc = documents.find((d) => d.id === activeId)
    if (!doc) return
    if (editor.getHTML() === doc.content) return
    isSwitchingRef.current = true
    editor.commands.setContent(doc.content, { emitUpdate: false })
    isSwitchingRef.current = false
    // documents intentionally omitted: we only swap content when activeId changes,
    // not on every keystroke (which mutates documents via onUpdate).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, editor])

  const handleNew = useCallback(() => {
    const doc: EditorDocument = { id: makeId(), name: "Untitled", content: EMPTY_DOC }
    setDocuments((prev) => [...prev, doc])
    setActiveId(doc.id)
  }, [])

  const handleOpenClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFilesSelected = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const opened: EditorDocument[] = []
      for (const file of Array.from(files)) {
        try {
          const text = await file.text()
          opened.push({ id: makeId(), name: file.name, content: fileToHtml(file.name, text) })
        } catch (err) {
          console.error(`Failed to read ${file.name}`, err)
        }
      }
      if (opened.length === 0) return
      setDocuments((prev) => [...prev, ...opened])
      setActiveId(opened[opened.length - 1].id)
    },
    [],
  )

  const handleClose = useCallback(
    (id: string) => {
      setDocuments((prev) => {
        const idx = prev.findIndex((d) => d.id === id)
        if (idx === -1) return prev
        const next = prev.filter((d) => d.id !== id)
        if (next.length === 0) {
          const fresh: EditorDocument = { id: makeId(), name: "Untitled", content: EMPTY_DOC }
          setActiveId(fresh.id)
          return [fresh]
        }
        if (id === activeId) {
          const neighbor = next[Math.min(idx, next.length - 1)]
          setActiveId(neighbor.id)
        }
        return next
      })
    },
    [activeId],
  )

  const handleRename = useCallback((id: string, name: string) => {
    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)))
  }, [])

  const handleSave = useCallback(async () => {
    if (!editor) return
    const doc = documents.find((d) => d.id === activeId)
    if (!doc) return
    // Pull fresh content directly from the editor — onUpdate may not have flushed
    // the very latest keystroke into state yet.
    const html = editor.getHTML()
    const suggestedName = /\.[a-z0-9]+$/i.test(doc.name) ? doc.name : `${doc.name}.html`
    await saveTextToFile(suggestedName, html)
    if (suggestedName !== doc.name) handleRename(doc.id, suggestedName)
  }, [editor, documents, activeId, handleRename])

  const handleSaveMarkdown = useCallback(async () => {
    if (!editor) return
    const doc = documents.find((d) => d.id === activeId)
    if (!doc) return
    const md = htmlToMarkdown(editor.getHTML())
    const stem = doc.name.replace(/\.[a-z0-9]+$/i, "")
    const suggestedName = `${stem || "untitled"}.md`
    await saveTextToFile(suggestedName, md)
  }, [editor, documents, activeId])

  if (!editor) return null

  return (
    <div className="simple-editor">
      <TabBar
        documents={documents}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={handleClose}
        onNew={handleNew}
        onOpen={handleOpenClick}
        onSave={handleSave}
        onSaveMarkdown={handleSaveMarkdown}
        onRename={handleRename}
        aiConfigured={aiConfigured}
        aiLoading={aiStatus.loading}
        onOpenAiSettings={() => setAiPanelOpen((v) => !v)}
        onTriggerAi={() => editor.commands.triggerAiCompletion()}
      />
      {aiPanelOpen && (
        <AiSettingsPanel
          onClose={() => setAiPanelOpen(false)}
          onSaved={() => setAiConfigured(isConfigured())}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={OPEN_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void handleFilesSelected(e.target.files)
          // reset so selecting the same file twice still triggers change
          e.target.value = ""
        }}
      />
      <EditorContext.Provider value={{ editor }}>
        <Toolbar editor={editor} />
        <AiStatusBanner
          configured={aiConfigured}
          status={aiStatus}
          onConfigure={() => setAiPanelOpen(true)}
          onDismiss={() => editor.commands.dismissAiCompletion()}
        />
        <EditorContent editor={editor}>
          <EmojiDropdownMenu />
          <MentionDropdownMenu />
          <SlashDropdownMenu />
        </EditorContent>
        <SpecTemplateChat
          editor={editor}
          configured={aiConfigured}
          onConfigure={() => setAiPanelOpen(true)}
        />
      </EditorContext.Provider>
    </div>
  )
}

interface AiStatusBannerProps {
  configured: boolean
  status: AiCompletionState
  onConfigure: () => void
  onDismiss: () => void
}

function AiStatusBanner({
  configured,
  status,
  onConfigure,
  onDismiss,
}: AiStatusBannerProps) {
  if (status.error) {
    const isConfigError = !configured
    return (
      <div className="simple-editor__banner is-error" role="status">
        <span className="simple-editor__banner-text">{status.error}</span>
        {isConfigError ? (
          <button
            type="button"
            className="simple-editor__btn is-active"
            onClick={onConfigure}
          >
            Configure
          </button>
        ) : (
          <button type="button" className="simple-editor__btn" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    )
  }
  if (status.loading) {
    return (
      <div className="simple-editor__banner is-loading" role="status">
        <span className="simple-editor__banner-text">Thinking…</span>
      </div>
    )
  }
  if (status.suggestion) {
    return (
      <div className="simple-editor__banner is-hint" role="status">
        <span className="simple-editor__banner-text">
          Suggestion ready — <kbd>Tab</kbd> to accept, <kbd>Esc</kbd> to dismiss.
        </span>
      </div>
    )
  }
  return null
}

export default SimpleEditor
