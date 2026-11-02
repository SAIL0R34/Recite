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

/** Minimal local shape — TS DOM libs before 5.9 ship no WakeLockSentinel. */
interface WakeLockSentinelLike {
  release(): Promise<void>
  released?: boolean
}

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
  // partial section ended: resume there once more audio has landed
  private _wait: { section: number; playedMs: number } | null = null
  // sleep-timer fade (a generation token lets cancelFade abort mid-ramp)
  private _fadeTimer: ReturnType<typeof setInterval> | null = null
  private _fadeGen = 0
  private wakeSentinel: WakeLockSentinelLike | null = null
  private lastPosPush = 0

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
    this.cancelFade()
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio = null
    }
    this.releaseWakeLock()
    this.preloadHref = null
    this._wait = null
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
    if (!entry || !entry.ready) {
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
   * nearest ready section so playback is never dead-ended. A seek never
   * interrupts narration: swapping src stops a playing element, so the
   * playing state is captured first and re-established after the jump. */
  async seekToGlobalMs(ms: number): Promise<boolean> {
    const tl = this.tl
    if (!tl || !this.manifest || tl.totalMs <= 0) return false
    let pos = globalToPosition(tl, ms)
    const entry = this.entry(pos.section)
    if (!entry) return false
    if (!entry.ready) {
      const near = this.nearestReady(entry.section)
      if (near === null) return false
      this._sectionIdx = near
      pos = { section: near, offset: 0 }
    }
    const sec = this.sectionOf(pos.section)
    if (!sec) return false
    const wasPlaying = this.playing // loadSrc may swap src and stop it
    if (!(await this.loadSrc(sec))) return false
    const dur = this.audio!.duration || sec.duration_ms / 1000
    this.audio!.currentTime = Math.min(
      pos.offset / 1000,
      Math.max(0, dur - 0.05),
    )
    this._sectionIdx = pos.section
    if (wasPlaying) {
      try {
        await this.audio!.play()
      } catch {
        /* autoplay policy / interrupted */
      }
    }
    this.emitState()
    this.emitTick()
    return true
  }

  /** Next/prev READY section boundary (the J/L semantics), preserving the
   * playing state — also what the OS next/previous-track handlers drive. */
  nextSection(): Promise<boolean> {
    const n = this.nextReadyAfter(this._sectionIdx)
    const e = n === null ? null : this.entry(n)
    return e ? this.seekToGlobalMs(e.startMs) : Promise.resolve(false)
  }
  prevSection(): Promise<boolean> {
    const p = this.prevReadyBefore(this._sectionIdx)
    const e = this.entry(p ?? this._sectionIdx) // none before → restart current
    return e ? this.seekToGlobalMs(e.startMs) : Promise.resolve(false)
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
    const setH = (
      action: string,
      fn: (d?: { seekTime?: number | null; fastSeek?: boolean | null }) => void,
    ) => {
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
    // The OS scrubber speaks SECTION-relative seconds — the <audio> src is
    // one MP3 per section — so resolve on that axis and clamp to the entry:
    // an overshoot must not spill into the next section.
    setH('seekto', (d) => {
      const t = d?.seekTime
      if (typeof t !== 'number' || !Number.isFinite(t)) return
      const e = this.entry(this._sectionIdx)
      if (!e) return
      void this.seekToGlobalMs(Math.min(e.startMs + t * 1000, e.endMs))
    })
    setH('nexttrack', () => void this.nextSection())
    setH('previoustrack', () => void this.prevSection())
  }

  setMediaTitle(title: string, artist: string, artworkSrc?: string): void {
    const ms =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { mediaSession?: MediaSession }).mediaSession
        : undefined
    if (!ms || typeof MediaMetadata === 'undefined') return
    try {
      ms.metadata = new MediaMetadata({
        title,
        artist,
        album: 'Recite',
        // type omitted: cover.jpg vs cover.png is per-book unknown, and
        // both sizes and type are optional hints the UA may ignore
        artwork: artworkSrc ? [{ src: artworkSrc, sizes: '512x512' }] : undefined,
      })
    } catch {
      /* ignore */
    }
  }

  /** OS media UI position — section-relative, matching the audio src (for
   *  a still-synthesizing section, the partial prefix is the src, and its
   *  audio.duration is exactly what we publish). */
  private pushPositionState(): void {
    const ms =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { mediaSession?: MediaSession }).mediaSession
        : undefined
    const a = this.audio
    if (!ms || typeof ms.setPositionState !== 'function' || !a) return
    const e = this.entry(this._sectionIdx)
    const duration =
      Number.isFinite(a.duration) && a.duration > 0
        ? a.duration
        : e
          ? e.durationMs / 1000
          : 0
    if (!(duration > 0)) return
    try {
      ms.setPositionState({
        duration,
        position: Math.min(a.currentTime, duration),
        playbackRate: this._rate,
      })
    } catch {
      /* invalid state / unsupported */
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
    // A still-synthesizing section plays its partial prefix; ?v busts the
    // cache each time the prefix grows or the final render lands.
    const partial = sec.status !== 'ready' && !!sec.partial_audio
    const file = partial ? sec.partial_audio : sec.audio
    const v = partial ? sec.partial_ms ?? 0 : sec.duration_ms
    return `/api/books/${encodeURIComponent(this.bookId ?? '')}/${file}?v=${v}`
  }

  /** Continue a partial section whose audio has grown (or finalised).
   * Called after manifest refreshes; a no-op while nothing was waiting. */
  async resumeWaiting(): Promise<boolean> {
    const w = this._wait
    if (!w) return false
    const sec = this.sectionOf(w.section)
    if (!sec) { this._wait = null; return false }
    const grew = (sec.partial_ms ?? 0) >= w.playedMs + 1500
    if (!(sec.status === 'ready' || grew)) return false
    this._wait = null
    this._sectionIdx = w.section
    if (!(await this.loadSrc(sec))) return false
    const a = this.audio!
    a.currentTime = Math.min(
      w.playedMs / 1000 + 0.05,
      Math.max(0, (a.duration || 0) - 0.1),
    )
    this.applyRate()
    try {
      await a.play()
    } catch {
      /* autoplay policy */
    }
    this.emitState()
    this.emitTick()
    return true
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
    a.addEventListener('ended', () => {
      this.releaseWakeLock()
      this.handleEnded()
    })
    a.addEventListener('play', () => {
      void this.acquireWakeLock()
      this.emitState()
    })
    a.addEventListener('pause', () => {
      this.releaseWakeLock()
      this.emitState()
    })
    // Wake locks die with document visibility; take it back when we return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.playing)
        void this.acquireWakeLock()
    })
    window.addEventListener('pagehide', () => this.releaseWakeLock())
    this.audio = a
    return a
  }

  /** Keep the screen awake while narrating — read-along means eyes on the
   *  page. No-op where unsupported (request rejects when the document is
   *  hidden; visibilitychange retries). */
  private async acquireWakeLock(): Promise<void> {
    if (this.wakeSentinel || typeof navigator === 'undefined') return
    const wl = (
      navigator as unknown as {
        wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> }
      }
    ).wakeLock
    if (!wl) return
    try {
      this.wakeSentinel = await wl.request('screen')
    } catch {
      this.wakeSentinel = null
    }
  }

  private releaseWakeLock(): void {
    const s = this.wakeSentinel
    this.wakeSentinel = null
    if (s) void s.release().catch(() => undefined)
  }

  /** Gentle linear ramp to silence over fadeMs, then pause and restore
   *  volume — the sleep timer's exit. An interval, not rAF: hidden tabs
   *  stop rAF entirely while a throttled interval still lands. Every exit
   *  path restores volume so the next manual play is never silent. */
  fadeOutAndPause(fadeMs: number): Promise<void> {
    this.cancelFade()
    const a = this.audio
    if (!a || a.paused) {
      if (a) a.volume = 1
      return Promise.resolve()
    }
    const gen = ++this._fadeGen
    const t0 = performance.now()
    return new Promise<void>((resolve) => {
      const step = () => {
        if (gen !== this._fadeGen || !this.audio) {
          resolve()
          return
        }
        const el = this.audio
        if (el.paused) {
          el.volume = 1
          resolve()
          return
        }
        const k = Math.min(1, (performance.now() - t0) / Math.max(1, fadeMs))
        el.volume = Math.max(0, 1 - k)
        if (k >= 1) {
          el.pause()
          el.volume = 1
          resolve()
        }
      }
      this._fadeTimer = setInterval(step, 100)
      step()
    }).finally(() => {
      if (this._fadeTimer) {
        clearInterval(this._fadeTimer)
        this._fadeTimer = null
      }
    })
  }

  /** Abort a running fade at full volume (the sleep timer was cancelled). */
  cancelFade(): void {
    this._fadeGen++
    if (this._fadeTimer) {
      clearInterval(this._fadeTimer)
      this._fadeTimer = null
    }
    if (this.audio) this.audio.volume = 1
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
    this.pushPositionState() // the OS UI's progress speed follows the rate
  }

  private handleEnded(): void {
    const sec = this.sectionOf(this._sectionIdx)
    if (sec && sec.status !== 'ready' && sec.partial_audio) {
      // Part of this section is still rendering. Park at the end of the
      // prefix; resumeWaiting() continues (or hops to the final render)
      // once the manifest reports more audio.
      this._wait = {
        section: this._sectionIdx,
        playedMs: (this.audio?.duration ?? 0) * 1000,
      }
      this.pause()
      return
    }
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
    this.raf = 0 // a fired frame is no longer pending; re-arm below
    const a = this.audio
    const e = this.entry(this._sectionIdx)
    if (a && this.tl && e && a.getAttribute('data-src')) {
      const g = e.startMs + a.currentTime * 1000
      for (const l of this.ticks) l(g)
      this.maybePreload(g)
      // OS media UI position at ~1 Hz — plenty for a lock-screen scrubber
      if (!a.paused && performance.now() - this.lastPosPush > 1000) {
        this.lastPosPush = performance.now()
        this.pushPositionState()
      }
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
    // play/pause/seek/section transitions all emit — keep the OS UI honest
    this.pushPositionState()
  }
}

export const engine = new PlayerEngine()
