// The single <audio>-element conductor.
//
// One element, one seek path (seekToGlobalMs), one rAF loop that emits a
// globalMs number. Everything the UI does — scrubber, ±10s, chapter jump,
// bookmark, resume — funnels through seekToGlobalMs. No Web Audio, no buffer
// plumbing: MP3 + <audio> keeps Safari honest and preservesPitch free.

import type { Manifest, ManifestSection } from '../types'
import {
  buildTimeline,
  globalToPosition,
  type Timeline,
} from './timeline'

export type TickListener = (globalMs: number) => void
export type StateListener = (s: { playing: boolean; sectionIdx: number }) => void

const PRELOAD_AHEAD_MS = 30_000

class PlayerEngine {
  private audio: HTMLAudioElement | null = null
  private bookId: string | null = null
  private manifest: Manifest | null = null
  private tl: Timeline | null = null
  private raf = 0
  private ticks = new Set<TickListener>()
  private states = new Set<StateListener>()
  private preloadHref: string | null = null
  private _sectionIdx = 0
  private _rate = 1

  // ---- subscriptions -----------------------------------------------

  onTick(cb: TickListener): () => void {
    this.ticks.add(cb)
    return () => this.ticks.delete(cb)
  }
  onState(cb: StateListener): () => void {
    this.states.add(cb)
    return () => this.states.delete(cb)
  }
  /** Raw media element (for pause/ended DOM listeners e.g. progress saves). */
  get element(): HTMLAudioElement | null {
    return this.audio
  }
  get playing(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended
  }
  get sectionIdx(): number {
    return this._sectionIdx
  }
  get timeline(): Timeline | null {
    return this.tl
  }

  // ---- lifecycle ----------------------------------------------------

  load(bookId: string, manifest: Manifest): void {
    this.stopLoop()
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio = null
    }
    this.preloadHref = null
    this.bookId = bookId
    this.manifest = manifest
    this.tl = buildTimeline(manifest)
    const first = this.tl.entries.find((e) => e.ready) ?? this.tl.entries[0]
    if (first) this._sectionIdx = first.section
    this.startLoop()
  }

  /** Refresh generation state in place; audio position is untouched. */
  setManifest(manifest: Manifest, keepLoop = true): void {
    this.manifest = manifest
    this.tl = buildTimeline(manifest)
    if (!keepLoop) return
  }

  // ---- transport ------------------------------------------------------

  async play(): Promise<void> {
    if (!this.tl || !this.manifest) return
    const entry = this.entry(this._sectionIdx)
    if (!entry || entry.status !== 'ready') {
      const near = this.nearestReady(this._sectionIdx)
      if (near === null) return
      this._sectionIdx = near
    }
    const sec = this.sectionOf(this._sectionIdx)
    if (!sec) return
    if (!(await this.loadSrc(sec))) return
    this.applyRate()
    try {
      await this.audio!.play()
    } catch {
      /* autoplay policy / interrupted — stay paused */
    }
    this.emitState()
  }

  pause(): void {
    this.audio?.pause()
    this.emitState()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else void this.play()
  }

  setRate(rate: number): void {
    this._rate = Math.min(2.5, Math.max(0.5, rate))
    this.applyRate()
  }
  get rate(): number {
    return this._rate
  }

  /** THE seek path. Global ms → {section, offset} → (maybe) swap src →
   * set currentTime. If the target section isn't ready, falls back to the
   * nearest ready section so playback is never dead-ended. */
  async seekToGlobalMs(ms: number): Promise<boolean> {
    const tl = this.tl
    if (!tl || !this.manifest || tl.totalMs <= 0) return false
    let pos = globalToPosition(tl, ms)
    const entry = this.entry(pos.section)
    if (!entry) return false
    if (entry.status !== 'ready') {
      const near = this.nearestReady(entry.section)
      if (near === null) return false
      this._sectionIdx = near
      pos = { section: near, offset: 0 }
    }
    const sec = this.sectionOf(pos.section)
    if (!sec) return false
    if (!(await this.loadSrc(sec))) return false
    const dur = this.audio!.duration || sec.duration_ms / 1000
    this.audio!.currentTime = Math.min(
      pos.offset / 1000,
      Math.max(0, dur - 0.05),
    )
    this._sectionIdx = pos.section
    this.emitState()
    this.emitTick()
    return true
  }

  /** ±ms from the current global position (the one call site for ±10s). */
  async seekRelative(ms: number): Promise<boolean> {
    return this.seekToGlobalMs(this.getGlobalMs() + ms)
  }

  getGlobalMs(): number {
    const e = this.entry(this._sectionIdx)
    if (!e || !this.audio) return 0
    return e.startMs + this.audio.currentTime * 1000
  }

  /** Section + offset for a global timestamp (seek-target resolver). */
  positionFor(ms: number) {
    return this.tl ? globalToPosition(this.tl, ms) : { section: 0, offset: 0 }
  }

  // ---- media session ----------------------------------------------------

  setupMediaSession(): void {
    const ms =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { mediaSession?: MediaSession }).mediaSession
        : undefined
    if (!ms) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setH = (action: string, fn: () => void) => {
      try {
        ;(ms as any).setActionHandler(action, fn)
      } catch {
        /* action unsupported in this browser */
      }
    }
    setH('play', () => void this.play())
    setH('pause', () => this.pause())
    setH('seekbackward', () => void this.seekRelative(-10_000))
    setH('seekforward', () => void this.seekRelative(10_000))
  }

  setMediaTitle(title: string, artist: string): void {
    const ms =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { mediaSession?: MediaSession }).mediaSession
        : undefined
    if (!ms || typeof MediaMetadata === 'undefined') return
    try {
      ms.metadata = new MediaMetadata({ title, artist, album: 'Recite' })
    } catch {
      /* ignore */
    }
  }

  // ---- internals ---------------------------------------------------------

  private entry(idx: number) {
    return this.tl?.byIndex[idx]
  }
  private sectionOf(idx: number): ManifestSection | undefined {
    return this.manifest?.sections.find((s) => s.idx === idx)
  }
  private url(sec: ManifestSection): string {
    return `/api/books/${encodeURIComponent(this.bookId ?? '')}/${sec.audio}`
  }
  private nextReadyAfter(idx: number): number | null {
    if (!this.tl) return null
    const e = this.tl.entries.find((x) => x.section > idx && x.ready)
    return e ? e.section : null
  }
  private prevReadyBefore(idx: number): number | null {
    if (!this.tl) return null
    const before = this.tl.entries.filter((x) => x.ready && x.section < idx)
    return before.length ? before[before.length - 1].section : null
  }
  /** Nearest ready section: forward first (so playback continues),
   * then backward, or null if nothing is ready. */
  nearestReady(idx: number): number | null {
    return this.nextReadyAfter(idx) ?? this.prevReadyBefore(idx)
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio
    const a = new Audio()
    a.preload = 'auto'
    a.addEventListener('ended', () => this.handleEnded())
    a.addEventListener('play', () => this.emitState())
    a.addEventListener('pause', () => this.emitState())
    this.audio = a
    return a
  }

  /** Set src iff it differs; wait for loadedmetadata so currentTime works. */
  private loadSrc(sec: ManifestSection): Promise<boolean> {
    const a = this.ensureAudio()
    const url = this.url(sec)
    if (a.getAttribute('data-src') === url) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        a.removeEventListener('loadedmetadata', onOk)
        a.removeEventListener('error', onBad)
        if (ok) {
          a.setAttribute('data-src', url)
          this.applyRate()
        }
        resolve(ok)
      }
      const onOk = () => finish(true)
      const onBad = () => finish(false)
      a.addEventListener('loadedmetadata', onOk, { once: true })
      a.addEventListener('error', onBad, { once: true })
      a.src = url
    })
  }

  private applyRate(): void {
    const a = this.audio
    if (!a) return
    a.playbackRate = this._rate
    // Safari needs the prefixed variant; Chrome only knows the plain one.
    try {
      ;(a as unknown as { preservesPitch: boolean }).preservesPitch = true
    } catch {
      /* ignore */
    }
    try {
      ;(a as unknown as { webkitPreservesPitch: boolean }).webkitPreservesPitch =
        true
    } catch {
      /* ignore */
    }
  }

  private handleEnded(): void {
    const next = this.nextReadyAfter(this._sectionIdx)
    if (next === null) {
      this.pause()
      return
    }
    const e = this.entry(next)
    if (e) {
      void this.seekToGlobalMs(e.startMs).then((ok) => { if (ok) void this.play() })
    }
  }

  private maybePreload(globalMs: number): void {
    const cur = this.entry(this._sectionIdx)
    if (!cur) return
    const next = this.nextReadyAfter(this._sectionIdx)
    if (next === null) return
    const e = this.entry(next)
    if (!e || e.startMs - globalMs > PRELOAD_AHEAD_MS) return
    const sec = this.sectionOf(next)
    if (!sec) return
    const href = this.url(sec)
    if (this.preloadHref === href) return
    this.preloadHref = href
    let link = document.getElementById('recite-preload-audio') as
      | HTMLLinkElement
      | null
    if (!link) {
      link = document.createElement('link')
      link.id = 'recite-preload-audio'
      document.head.appendChild(link)
    }
    link.rel = 'preload'
    link.as = 'audio'
    link.href = href
  }

  private loop = (): void => {
    const a = this.audio
    const e = this.entry(this._sectionIdx)
    if (a && this.tl && e && a.getAttribute('data-src')) {
      const g = e.startMs + a.currentTime * 1000
      for (const l of this.ticks) l(g)
      this.maybePreload(g)
    }
    this.startLoop()
  }
  private startLoop(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop)
  }
  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private emitTick(): void {
    const g = this.getGlobalMs()
    for (const l of this.ticks) l(g)
  }
  private emitState(): void {
    const s = { playing: this.playing, sectionIdx: this._sectionIdx }
    for (const l of this.states) l(s)
  }
}

export const engine = new PlayerEngine()
