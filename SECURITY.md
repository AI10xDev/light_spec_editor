# Security Policy

## Secrets and local configuration

Do not commit API keys, Tiptap registry tokens, Azure OpenAI keys, or generated
`.npmrc` files. The repository ignores `.npmrc`; use `.npmrc.example` only as a
template.

Vite exposes every `VITE_*` variable to client-side JavaScript. Values such as
`VITE_AZURE_OPENAI_API_KEY`, `VITE_TIPTAP_COLLAB_TOKEN`, and
`VITE_TIPTAP_AI_TOKEN` are suitable only for local development or trusted
internal prototypes.

## Production guidance

For any public deployment:

- Keep Azure OpenAI and Tiptap tokens on a backend service.
- Issue short-lived collaboration and AI tokens from server endpoints.
- Proxy Azure OpenAI requests through the backend instead of sending provider
  keys from the browser.
- Restrict Azure OpenAI CORS origins to the expected app domains.
- Rotate any key that was exposed in browser localStorage, logs, screenshots, or
  committed files.

## Reporting issues

Open a private report with the maintainer if you find a leaked credential,
authentication bypass, dependency confusion risk, or unsafe production
configuration.
