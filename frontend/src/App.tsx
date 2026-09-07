import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import LibraryView from './library/LibraryView'
import ReaderView from './reader/ReaderView'
import { useLibraryStore } from './stores/libraryStore'
import { useSettingsStore } from './stores/settingsStore'
import AppearancePanel from './reader/AppearancePanel'
import ToastHost from './library/ToastHost'
import { useState } from 'react'

function NotFound() {
  return (
    <div className="p-10 text-center" style={{ color: 'var(--muted)' }}>
      Not found —{' '}
      <a href="/" style={{ color: 'var(--accent)' }}>
        back to library
      </a>
    </div>
  )
}

export default function App() {
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  // keep settings warm for the header button
  void useSettingsStore.getState().load()

  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
        <header
          className="flex items-center justify-between border-b px-5 py-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <a href="/" className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-tight">Recite</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              listen &amp; read along
            </span>
          </a>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              onClick={() => setAppearanceOpen((v) => !v)}
              title="Appearance"
            >
              Aa
            </button>
            <button
              className="btn btn-sm"
              onClick={() => void useLibraryStore.getState().refresh()}
              title="Refresh library"
            >
              ↻
            </button>
          </div>
        </header>
        {appearanceOpen && (
          <div className="absolute right-4 top-12 z-40">
            <AppearancePanel />
          </div>
        )}
        {/* library scrolls here; the reader is exactly h-full and scrolls
            only inside its text pane, so a book page never gets a global bar */}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<LibraryView />} />
            <Route path="/book/:id" element={<ReaderView />} />
            <Route path="/book" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <ToastHost />
      </div>
    </BrowserRouter>
  )
}
