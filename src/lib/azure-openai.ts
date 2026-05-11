export interface AzureOpenAIConfig {
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
}

const STORAGE_KEY = "azure-openai-config"
const SYSTEM_PROMPT_KEY = "azure-openai-system-prompt"
const SAVED_PROMPTS_KEY = "azure-openai-saved-prompts"
const DEFAULT_API_VERSION = "2024-10-21"

/**
 * Strip path suffixes people commonly paste from Foundry/SDK examples
 * (e.g. ".../openai/v1", ".../openai") so the request builder can append
 * /openai/deployments/<dep>/... cleanly.
 */
function normalizeEndpoint(input: string | undefined): string {
  if (!input) return ""
  let out = input.trim()
  // Strip query/fragment.
  out = out.replace(/[?#].*$/, "")
  // Strip any trailing path that starts with /openai...
  out = out.replace(/\/openai(\/.*)?$/i, "")
  // Strip trailing slashes.
  out = out.replace(/\/+$/, "")
  return out
}
export const DEFAULT_SYSTEM_PROMPT =
  "You are an inline autocomplete engine for an author writing a Feature & Technical Requirements Spec Sheet. " +
  "Your job is to extend the document the user is writing in the precise voice and structure of a software requirements specification: " +
  "crisp, unambiguous, testable. Prefer requirement-style verbs (MUST, SHOULD, MAY per RFC 2119), measurable acceptance criteria, " +
  "concrete inputs/outputs, and explicit edge cases over prose. When continuing a list, keep the numbering or bullet style consistent. " +
  "When continuing a section heading like 'Functional Requirements', 'Non-Functional Requirements', 'API Contract', " +
  "'Acceptance Criteria', 'Data Model', 'Dependencies', 'Out of Scope', or 'Risks', produce content appropriate to that section. " +
  "Output ONLY the continuation — no quotes, no preamble, no Markdown fences, no repetition of the input. " +
  "If the input ends mid-word, complete the word; if mid-sentence, complete the sentence. " +
  "Keep it under 40 words and never start a new paragraph."

export interface SavedSystemPrompt {
  name: string
  prompt: string
}

export function getActiveSystemPrompt(): string {
  if (typeof localStorage === "undefined") return DEFAULT_SYSTEM_PROMPT
  try {
    const raw = localStorage.getItem(SYSTEM_PROMPT_KEY)
    if (typeof raw === "string" && raw.trim()) return raw
  } catch {
    // fall through
  }
  return DEFAULT_SYSTEM_PROMPT
}

export function setActiveSystemPrompt(prompt: string): void {
  if (typeof localStorage === "undefined") return
  if (!prompt.trim()) {
    localStorage.removeItem(SYSTEM_PROMPT_KEY)
    return
  }
  try {
    localStorage.setItem(SYSTEM_PROMPT_KEY, prompt)
  } catch (err) {
    console.warn("Failed to persist active system prompt", err)
  }
}

export function listSavedPrompts(): SavedSystemPrompt[] {
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(SAVED_PROMPTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is SavedSystemPrompt =>
        !!item &&
        typeof (item as SavedSystemPrompt).name === "string" &&
        typeof (item as SavedSystemPrompt).prompt === "string",
    )
  } catch {
    return []
  }
}

function writeSavedPrompts(list: SavedSystemPrompt[]): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(list))
  } catch (err) {
    console.warn("Failed to persist saved prompts", err)
  }
}

export function saveNamedPrompt(name: string, prompt: string): SavedSystemPrompt[] {
  const cleaned = name.trim()
  if (!cleaned) throw new Error("Name required")
  const list = listSavedPrompts()
  const idx = list.findIndex((p) => p.name === cleaned)
  const entry: SavedSystemPrompt = { name: cleaned, prompt }
  if (idx === -1) list.push(entry)
  else list[idx] = entry
  writeSavedPrompts(list)
  return list
}

export function deleteSavedPrompt(name: string): SavedSystemPrompt[] {
  const list = listSavedPrompts().filter((p) => p.name !== name)
  writeSavedPrompts(list)
  return list
}

interface EnvShape {
  readonly VITE_AZURE_OPENAI_ENDPOINT?: string
  readonly VITE_AZURE_OPENAI_API_KEY?: string
  readonly VITE_AZURE_OPENAI_DEPLOYMENT?: string
  readonly VITE_AZURE_OPENAI_API_VERSION?: string
}

function envConfig(): Partial<AzureOpenAIConfig> {
  const env = (import.meta as unknown as { env?: EnvShape }).env ?? {}
  return {
    endpoint: env.VITE_AZURE_OPENAI_ENDPOINT,
    apiKey: env.VITE_AZURE_OPENAI_API_KEY,
    deployment: env.VITE_AZURE_OPENAI_DEPLOYMENT,
    apiVersion: env.VITE_AZURE_OPENAI_API_VERSION,
  }
}

function storedConfig(): Partial<AzureOpenAIConfig> {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<AzureOpenAIConfig>
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function getConfig(): AzureOpenAIConfig | null {
  // Env vars take precedence; fall back to user-provided values in localStorage.
  const env = envConfig()
  const stored = storedConfig()
  const merged: Partial<AzureOpenAIConfig> = {
    endpoint: env.endpoint || stored.endpoint,
    apiKey: env.apiKey || stored.apiKey,
    deployment: env.deployment || stored.deployment,
    apiVersion: env.apiVersion || stored.apiVersion || DEFAULT_API_VERSION,
  }
  if (!merged.endpoint || !merged.apiKey || !merged.deployment) return null
  return merged as AzureOpenAIConfig
}

export function setStoredConfig(config: Partial<AzureOpenAIConfig>): void {
  if (typeof localStorage === "undefined") return
  const cleaned: Partial<AzureOpenAIConfig> = {
    endpoint: normalizeEndpoint(config.endpoint),
    apiKey: config.apiKey?.trim(),
    deployment: config.deployment?.trim(),
    apiVersion: config.apiVersion?.trim() || DEFAULT_API_VERSION,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
}

export function clearStoredConfig(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(STORAGE_KEY)
}

export function isConfigured(): boolean {
  return getConfig() !== null
}

interface ChatChoice {
  message?: { content?: string | null; refusal?: string | null }
  finish_reason?: string
}
interface ChatResponse {
  choices?: ChatChoice[]
  error?: { message?: string }
}

export interface CompletionOptions {
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export async function chatCompletion(
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<string> {
  const config = getConfig()
  if (!config) throw new Error("Azure OpenAI is not configured")

  const endpoint = normalizeEndpoint(config.endpoint)
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(
    config.deployment,
  )}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    body: JSON.stringify({
      messages,
      // 4096 leaves headroom for reasoning models (gpt-5/o1/o3) which spend
      // tokens on internal reasoning before any visible output. With 2048
      // they routinely return empty content + finish_reason "length".
      max_completion_tokens: options.maxTokens ?? 4096,
    }),
    signal: options.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Azure OpenAI error ${res.status}: ${text || res.statusText}`)
  }

  const data = (await res.json()) as ChatResponse
  const choice = data.choices?.[0]
  const content = choice?.message?.content ?? ""
  if (content.trim()) return content

  const refusal = choice?.message?.refusal
  if (refusal) throw new Error(`Model refused the request: ${refusal}`)

  const finish = choice?.finish_reason
  if (finish === "length") {
    throw new Error(
      "Model exhausted its token budget before producing visible output. " +
        "Reasoning models (gpt-5, o1, o3) spend tokens on internal reasoning — " +
        "try a non-reasoning deployment or raise max_completion_tokens.",
    )
  }
  if (finish === "content_filter") {
    throw new Error("Response was blocked by Azure content filter.")
  }

  throw new Error(
    `Empty response from Azure OpenAI${finish ? ` (finish_reason: ${finish})` : ""}.`,
  )
}

export async function getCompletion(
  prefix: string,
  options: CompletionOptions = {},
): Promise<string> {
  const config = getConfig()
  if (!config) throw new Error("Azure OpenAI is not configured")

  const endpoint = normalizeEndpoint(config.endpoint)
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(
    config.deployment,
  )}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`

  // Newer reasoning-class models (gpt-5, o1, o3, ...) reject `max_tokens`,
  // `temperature`, and `stop`. We use `max_completion_tokens` (the new
  // universal name; supported on api-version 2024-09-01-preview+ for older
  // models too) and skip the others to keep the body model-agnostic.
  const body = {
    messages: [
      { role: "system", content: getActiveSystemPrompt() },
      { role: "user", content: prefix },
    ],
    // 80 is enough output for an inline suggestion, but reasoning models
    // (gpt-5, o1, o3) need extra budget for internal reasoning before
    // producing the visible continuation. 512 keeps non-reasoning models
    // cheap while leaving room for reasoning models to finish.
    max_completion_tokens: options.maxTokens ?? 512,
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Azure OpenAI error ${res.status}: ${text || res.statusText}`)
  }

  const data = (await res.json()) as ChatResponse
  const raw = data.choices?.[0]?.message?.content ?? ""
  return cleanCompletion(raw, prefix)
}

export interface TestResult {
  ok: boolean
  status: number | null
  url: string
  message: string
}

export async function testConnection(
  config: Partial<AzureOpenAIConfig>,
): Promise<TestResult> {
  const endpoint = normalizeEndpoint(config.endpoint)
  const apiKey = config.apiKey?.trim() ?? ""
  const deployment = config.deployment?.trim() ?? ""
  const apiVersion = config.apiVersion?.trim() || DEFAULT_API_VERSION

  if (!endpoint || !apiKey || !deployment) {
    return {
      ok: false,
      status: null,
      url: "",
      message: "Fill in endpoint, API key, and deployment first.",
    }
  }

  const url = `${endpoint}/openai/deployments/${encodeURIComponent(
    deployment,
  )}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        // Reasoning models (gpt-5, o1, o3) spend tokens on internal reasoning
        // before any visible output; a tiny budget gets consumed there and
        // returns 400 "output limit reached". 256 is enough to confirm
        // connectivity on every model class.
        max_completion_tokens: 256,
      }),
    })
    if (res.ok) {
      return { ok: true, status: res.status, url, message: "Connected." }
    }
    const bodyText = await res.text().catch(() => "")
    let parsed: { error?: { message?: string; code?: string } } | null = null
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      parsed = null
    }
    const azureMsg = parsed?.error?.message || bodyText || res.statusText
    return {
      ok: false,
      status: res.status,
      url,
      message: explain(res.status, azureMsg),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // CORS rejections surface as TypeError "Failed to fetch" in the browser.
    if (/Failed to fetch|NetworkError/i.test(msg)) {
      return {
        ok: false,
        status: null,
        url,
        message:
          "Network/CORS failure. The Azure resource probably isn't allowing requests from this origin — add it under Resource Management → Networking → CORS.",
      }
    }
    return { ok: false, status: null, url, message: msg }
  }
}

function explain(status: number, azureMessage: string): string {
  switch (status) {
    case 401:
      return `401 Unauthorized — the API key is wrong or doesn't belong to this resource. (${azureMessage})`
    case 403:
      return `403 Forbidden — the key is valid but lacks permission for this deployment. (${azureMessage})`
    case 404:
      return `404 Resource not found — usually the deployment name doesn't match (case-sensitive), or the endpoint has an extra path. (${azureMessage})`
    case 429:
      return `429 Rate limited — quota exhausted or too many requests. (${azureMessage})`
    default:
      return `${status} ${azureMessage}`
  }
}

function cleanCompletion(raw: string, prefix: string): string {
  let out = raw

  // Some models echo the prompt back; strip any leading overlap with the prefix tail.
  const tail = prefix.slice(-80)
  if (tail && out.startsWith(tail)) out = out.slice(tail.length)

  // Strip Markdown code fences if the model wrapped the answer.
  out = out.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "")

  // Drop wrapping quotes the model sometimes adds.
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1)
  }

  // Preserve a single leading space when the prefix doesn't already end in whitespace.
  if (out && !/^\s/.test(out) && prefix && !/\s$/.test(prefix)) {
    out = " " + out
  }

  return out
}
