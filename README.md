# Spec Ops Editor

A lightweight editor for spec driven development - has a chabot for templates.

![Spec Ops Editor screenshot](docs/screenshot.png)

Built on [Tiptap](https://tiptap.dev/) and React, designed for writing technical specifications, RFCs, and design documents with minimal friction.

## Features

### Rich-text editing
- Headings, paragraphs, blockquotes, and horizontal rules
- Bold, italic, underline, strikethrough, code, subscript, and superscript
- Text color and highlight
- Text alignment (left, center, right, justify)
- Bullet, ordered, and task lists
- Code blocks with syntax-aware formatting
- Tables with row/column management
- Images and emoji
- Math expressions via Tiptap's mathematics extension
- Link insertion and editing
- Typography niceties (smart quotes, dashes, ellipses)

### Spec-driven workflow
- **Spec template chatbot** — a built-in assistant for generating boilerplate spec sections (problem statement, goals, non-goals, design, alternatives, rollout) from a short prompt
- Slash commands and mentions for quickly inserting templated blocks
- Drag handles for reordering sections
- Auto-generated table of contents
- Unique IDs on headings for stable anchor links

### Collaboration & AI
- Real-time collaboration powered by Yjs
- Collaboration carets to show other users' cursors
- Tiptap Pro AI extension for inline AI assistance

### Developer experience
- React 19 + TypeScript + Vite
- SCSS modules for styling
- ESLint configured for React and TypeScript

## Getting started

```bash
npm install
npm run dev
```

The dev server runs on Vite's default port (typically `http://localhost:5173`).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server with HMR |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run ESLint over the project |

## Project structure

```
src/
  components/
    simple-editor/        # Main editor shell
    spec-template-chat/   # Template chatbot
    tiptap-extension/     # Custom Tiptap extensions
    tiptap-node/          # Custom node views
    tiptap-templates/     # Pre-built spec templates
    tiptap-ui/            # Editor UI controls
    tiptap-ui-primitive/  # Low-level UI primitives
  contexts/               # React contexts
  hooks/                  # Shared hooks
  lib/                    # Utilities
  styles/                 # Global SCSS
```
