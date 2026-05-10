import { SimpleEditor } from "@/components/simple-editor/simple-editor"
import "./App.css"

function App() {
  return (
    <main className="app">
      <header className="app__header">
        <h1>Lightweight spec sheet editor</h1>
        <p>A minimal rich-text editor built on the Tiptap framework.</p>
      </header>
      <SimpleEditor placeholder="Start writing…" />
    </main>
  )
}

export default App
