import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './stores/settingsStore'
// Editorial display face, bundled (offline local-first app — no webfont links)
import '@fontsource-variable/newsreader'
import '@fontsource-variable/newsreader/wght-italic.css'
import './styles.css'

void useSettingsStore.getState().load()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Final progress flush is handled inside ReaderView (pagehide → sendBeacon).
