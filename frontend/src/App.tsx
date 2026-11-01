import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import LibraryView from './library/LibraryView'
import ReaderView from './reader/ReaderView'
import StatsView from './stats/StatsView'
import { useLibraryStore } from './stores/libraryStore'
import { useSettingsStore } from './stores/settingsStore'
import AppearancePanel from './reader/AppearancePanel'
import ToastHost from './library/ToastHost'
import BookTransition from './BookTransition'
import PraiseConfetti from './PraiseConfetti'
import { useEffect, useState } from 'react'

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
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}

function AppShell() {
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  // main.tsx loads settings pre-render; if the backend was down then, retry once
  useEffect(() => {
    if (!useSettingsStore.getState().loaded) void useSettingsStore.getState().load()
  }, [])

  // The reader route carries its own Aa control in its toolbar — showing
  // both duplicated the appearance menu on book pages.
  const onReader = useLocation().pathname.startsWith('/book')

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      <header
        className="flex items-center justify-between border-b px-5 py-2.5"
        style={{ borderColor: 'var(--hairline)' }}
      >
        {/* the masthead wordmark is the only <a>; siblings, not nested —
            an <a> inside an <a> is invalid DOM and React warns about it */}
        <div className="flex items-baseline gap-2.5">
          <a
            href="/"
            className="text-[22px] font-medium tracking-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Recite
          </a>
          <span className="kicker hidden sm:inline">listen &amp; read along</span>
          {!onReader && (
            <Link
              to="/stats"
              className="kicker stats-link hidden sm:inline"
              title="Reading analytics"
            >
              Statistics
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!onReader && (
            <button
              className="btn btn-sm"
              onClick={() => setAppearanceOpen((v) => !v)}
              title="Appearance"
            >
              Aa
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() => void useLibraryStore.getState().refresh()}
            title="Refresh library"
          >
            ↻
          </button>
        </div>
      </header>
      {appearanceOpen && !onReader && (
        <div className="popover-in absolute right-4 top-12 z-40">
          <AppearancePanel />
        </div>
      )}
      {/* main never scrolls: the library view and the reader pane own their
        own scrollbars, so no wheel over the transport bar can move the UI */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<LibraryView />} />
          <Route path="/stats" element={<StatsView />} />
          <Route path="/book/:id" element={<ReaderView />} />
          <Route path="/book" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <BookTransition />
      <PraiseConfetti />
      <ToastHost />
    </div>
  )
}
