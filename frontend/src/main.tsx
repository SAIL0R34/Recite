import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './stores/settingsStore'
import './styles.css'

void useSettingsStore.getState().load()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Final progress flush is handled inside ReaderView (pagehide → sendBeacon).
