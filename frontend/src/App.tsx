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
        {/* main never scrolls: the library view and the reader pane own their
            own scrollbars, so no wheel over the transport bar can move the UI */}
        <main className="min-h-0 flex-1 overflow-hidden">
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
