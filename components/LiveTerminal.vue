<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useIsSlideActive, useNav, useSlideContext } from '@slidev/client'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

const props = withDefaults(defineProps<{
  cmd?: string
  cast?: string
  mode?: 'live' | 'cast'
  fallbackKey?: string
  fontSize?: number
  rows?: number
  cwd?: string
  autoConnect?: boolean
  // Sessions are shared by (cwd, cmd): every terminal pointing at the same
  // command attaches to the same server-side PTY, which is what keeps the
  // presenter tab and the audience tab in sync. Set sid to force a separate
  // session for the same command.
  sid?: string
}>(), {
  cmd: '',
  mode: 'live',
  fallbackKey: 'f',
  fontSize: 14,
  autoConnect: true,
})

const isDev = import.meta.env.DEV
const { $renderContext } = useSlideContext()
const isActive = useIsSlideActive()
const nav = useNav()

// Live only in 'slide' and 'presenter' render contexts: presenter mode also
// mounts the next-slide preview ('previewNext'), which must not open a second
// PTY for the same demo. PROD builds and exports never get the live branch.
const liveFailed = ref(false)
const canLive = computed(() =>
  isDev
  && !liveFailed.value
  && ($renderContext.value === 'slide' || $renderContext.value === 'presenter'),
)

const activeMode = ref<'live' | 'cast'>(isDev ? props.mode : 'cast')
watch(() => props.mode, (m) => { activeMode.value = m })

const showLive = computed(() => canLive.value && activeMode.value === 'live')
const showCast = computed(() =>
  !!props.cast && (canLive.value ? activeMode.value === 'cast' : true))

const host = ref<HTMLDivElement>()
const castHost = ref<HTMLDivElement>()

const started = ref(false)
const exited = ref(false)
const disconnected = ref(false)
const maximized = ref(false)

// Scroll and maximize state travel over the session so the audience tab
// mirrors the presenter tab. The guard stops a relayed scroll from being
// broadcast straight back.
let suppressScroll = false
let scrollTimer: ReturnType<typeof setTimeout> | undefined
let pendingYpos: number | undefined

function toggleMaximize() {
  maximized.value = !maximized.value
  sendJson({ type: 'view', maximized: maximized.value })
}

let term: Terminal | undefined
let fitAddon: FitAddon | undefined
let ws: WebSocket | undefined
let everConnected = false
let intentionalClose = false
let resizeObserver: ResizeObserver | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// xterm is imported lazily so PROD builds never load it and it lands in a
// chunk fetched only when a live terminal actually initializes.
async function initTerm() {
  // Both packages ship CJS builds, and the interop shape depends on how the
  // consumer's bundler resolved this component (symlinked source vs a
  // pre-bundled node_modules dep), so look for the classes in both places.
  const [xtermMod, fitMod] = await Promise.all([
    import('@xterm/xterm') as Promise<any>,
    import('@xterm/addon-fit') as Promise<any>,
  ])
  const Terminal = xtermMod.Terminal ?? xtermMod.default?.Terminal
  const FitAddon = fitMod.FitAddon ?? fitMod.default?.FitAddon
  await import('@xterm/xterm/css/xterm.css')
  if (!host.value)
    return

  const theme = {
    background: cssVar('--ac-surface-lowest', '#0d0d0d'),
    foreground: cssVar('--ac-on-surface', '#e6e6e6'),
    cursor: cssVar('--ac-tertiary', '#7dd3fc'),
    red: cssVar('--ac-error', '#ef4444'),
    green: cssVar('--ac-success', '#22c55e'),
    yellow: cssVar('--ac-warning', '#f59e0b'),
  }
  term = new Terminal({
    theme,
    fontFamily: cssVar('--ac-font-mono', 'monospace'),
    fontSize: props.fontSize,
    cursorBlink: true,
    ...(props.rows !== undefined ? { rows: props.rows } : {}),
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host.value)
  fitAddon.fit()

  // No focus on init: a freshly shown slide must keep its keyboard on Slidev
  // navigation, not swallow arrows and space into the shell. The presenter
  // clicks the terminal to type. While any input has focus (the terminal's
  // hidden textarea counts), Slidev disables every shortcut of its own, so
  // merely letting PageUp/PageDown bubble is not enough: drive the deck's nav
  // directly. Clickers send exactly these two keys.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      if (e.type === 'keydown') {
        e.preventDefault()
        if (e.key === 'PageDown')
          nav.next()
        else
          nav.prev()
      }
      return false
    }
    return true
  })

  term.onData(d => sendJson({ type: 'input', data: d }))
  term.onResize(({ cols, rows }) => sendJson({ type: 'resize', cols, rows }))
  // onScroll fires per line; trail it a little so a wheel flick is one or two
  // frames on the wire instead of dozens.
  term.onScroll((ypos) => {
    if (suppressScroll)
      return
    pendingYpos = ypos
    if (scrollTimer)
      return
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      if (pendingYpos !== undefined)
        sendJson({ type: 'scroll', ypos: pendingYpos })
      pendingYpos = undefined
    }, 40)
  })

  resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => refit(), 50)
  })
  resizeObserver.observe(host.value)
}

// Never fit against a hidden host: under v-show (cast toggled in) the box is
// 0x0 and FitAddon would squeeze the PTY down to a few columns.
function refit() {
  if (host.value && host.value.clientWidth > 0 && host.value.clientHeight > 0)
    fitAddon?.fit()
}

function sendJson(msg: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg))
}

function connect() {
  if (!term)
    return
  started.value = true
  exited.value = false
  disconnected.value = false
  everConnected = false
  intentionalClose = false

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  let url = `${proto}://${location.host}/__pty?cmd=${encodeURIComponent(props.cmd)}&cols=${term.cols}&rows=${term.rows}`
  if (props.cwd)
    url += `&cwd=${encodeURIComponent(props.cwd)}`
  if (props.sid)
    url += `&sid=${encodeURIComponent(props.sid)}`

  ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { everConnected = true }
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'exit') {
        exited.value = true
        term?.write(`\r\n\x1b[2m[process exited (code ${msg.exitCode}), press r or click to restart]\x1b[0m`)
      } else if (msg.type === 'restart') {
        // Another tab attached to the same session respawned it.
        exited.value = false
        disconnected.value = false
        term?.reset()
      } else if (msg.type === 'scroll') {
        suppressScroll = true
        try {
          term?.scrollToLine(msg.ypos)
        } finally {
          suppressScroll = false
        }
      } else if (msg.type === 'view') {
        // Follow the other tab's maximize state, but only while this slide is
        // showing: an off-screen instance attached to the same session should
        // come back at its own size.
        if (isActive.value)
          maximized.value = !!msg.maximized
      }
      return
    }
    term?.write(new Uint8Array(ev.data as ArrayBuffer))
  }
  ws.onclose = () => {
    if (intentionalClose)
      return
    if (!everConnected) {
      // First connect never succeeded (no pty-server plugin, most likely):
      // drop to the cast if one exists, otherwise the placeholder.
      liveFailed.value = true
      if (props.cast)
        activeMode.value = 'cast'
      return
    }
    if (!exited.value) {
      disconnected.value = true
      term?.write('\r\n\x1b[2m[disconnected, press r or click to restart]\x1b[0m')
    }
  }
  ws.onerror = () => { /* onclose follows and handles it */ }
}

function closeWs() {
  if (ws) {
    intentionalClose = true
    ws.close()
    ws = undefined
  }
}

function restart() {
  closeWs()
  term?.reset()
  connect()
}

function start() {
  if (!started.value)
    connect()
}

// Do NOT connect in onMounted: Slidev mounts adjacent slides too. First
// activation is the trigger; deactivation keeps the session alive so the
// presenter can flip back mid-demo. flush: 'post' is load bearing here and
// on the cast watch below — both host divs exist only on conditional
// template branches, so with the default 'pre' flush these callbacks would
// run before the branch rendered and find the ref still undefined.
watch([isActive, activeMode], async ([active]) => {
  if (!active || !canLive.value || activeMode.value !== 'live' || initialized)
    return
  initialized = true
  await initTerm()
  if (props.autoConnect)
    connect()
}, { immediate: true, flush: 'post' })

let player: { dispose: () => void } | undefined

// asciinema-player is imported lazily for the same reason as xterm.
async function mountCast() {
  player?.dispose()
  player = undefined
  if (activeMode.value !== 'cast' || !props.cast || !castHost.value)
    return
  const playerMod: any = await import('asciinema-player')
  const create = playerMod.create ?? playerMod.default?.create
  await import('asciinema-player/dist/bundle/asciinema-player.css')
  player = create(props.cast, castHost.value, {
    autoPlay: true,
    loop: true,
    controls: false,
    fit: 'both',
  })
}

watch([activeMode, () => props.cast], mountCast, { flush: 'post' })

// Coming back from the cast: the box regains its size, so refit and put the
// keyboard back in the terminal.
watch(showLive, (live) => {
  if (live && term) {
    refit()
    term.focus()
  }
}, { flush: 'post' })

// Gated on isActive, unlike Frame.vue's global listener: a deck can hold
// several LiveTerminals, and an ungated listener would toggle off-screen ones.
function onKeydown(e: KeyboardEvent) {
  if (!isActive.value)
    return
  // Keys typed into the live shell bubble here too; a shortcut must not fire
  // while the presenter is typing a command. The restart key is exempt: with
  // the process gone, keystrokes reach no shell anyway.
  const typingInShell = !!host.value && host.value.contains(e.target as Node)
    && !exited.value && !disconnected.value
  if (e.key === props.fallbackKey && props.cast && canLive.value && !typingInShell) {
    activeMode.value = activeMode.value === 'cast' ? 'live' : 'cast'
    return
  }
  if (e.key === 'm' && showLive.value && !typingInShell) {
    toggleMaximize()
    return
  }
  if (e.key === 'r' && activeMode.value === 'live' && started.value && (exited.value || disconnected.value))
    restart()
}

onMounted(() => {
  mountCast()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  closeWs()
  term?.dispose()
  player?.dispose()
})
</script>

<template>
  <div class="live-terminal" :class="{ 'lt-max': maximized && showLive }">
    <!-- v-show, not v-if: toggling to the cast and back must not destroy the
         DOM xterm rendered into, or the terminal comes back blank. -->
    <div v-if="canLive" v-show="showLive" class="lt-live">
      <div ref="host" class="lt-host" />
      <button class="lt-maxbtn" :title="maximized ? 'restore (m)' : 'maximize (m)'" @click="toggleMaximize">
        {{ maximized ? '⤡' : '⤢' }}
      </button>
      <div v-if="!started && !autoConnect" class="lt-overlay" @click="start">
        <span>click to start</span>
      </div>
      <div v-else-if="exited || disconnected" class="lt-overlay lt-overlay-restart" @click="restart">
        <span>restart</span>
      </div>
    </div>
    <div v-if="showCast" ref="castHost" class="lt-cast" />
    <div v-if="!showLive && !showCast" class="lt-placeholder">
      <span>demo runs live, no recording attached</span>
    </div>
    <span v-if="cast && isDev" class="lt-hint">press {{ fallbackKey }} for {{ activeMode === 'cast' ? 'live' : 'cast' }}</span>
  </div>
</template>

<style scoped>
.live-terminal {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--ac-surface-lowest, #0d0d0d);
  display: flex;
  overflow: hidden;
}

/* position: fixed resolves against the slide canvas, not the browser window,
   because Slidev scales slides with a CSS transform and a transformed
   ancestor becomes the containing block. That is exactly the wanted effect:
   maximize fills the slide, escapes the chrome's overflow clipping, and
   scales with the projection. */
.lt-max {
  position: fixed;
  inset: 0;
  z-index: 60;
  padding: var(--ac-space-4, 14px);
}

.lt-live,
.lt-host,
.lt-cast {
  position: relative;
  width: 100%;
  height: 100%;
}

.lt-host :deep(.xterm) {
  height: 100%;
}

.lt-placeholder {
  margin: auto;
  color: var(--ac-on-surface-dim, #888);
  font-family: var(--ac-font-mono, monospace);
}

.lt-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--ac-on-surface-dim, #888);
  font-family: var(--ac-font-mono, monospace);
  background: color-mix(in srgb, var(--ac-surface-lowest, #0d0d0d) 40%, transparent);
}

.lt-overlay-restart {
  align-items: flex-end;
  justify-content: flex-end;
  padding: 0.5rem 0.75rem;
  background: none;
}

.lt-maxbtn {
  position: absolute;
  top: var(--ac-space-2, 0.5rem);
  right: var(--ac-space-2, 0.5rem);
  z-index: 1;
  border: 0;
  padding: 0 0.3rem;
  background: none;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1.4;
  color: var(--ac-on-surface-dim, #888);
  opacity: 0;
  transition: opacity 0.15s;
}

.lt-live:hover .lt-maxbtn {
  opacity: 0.8;
}

.lt-hint {
  position: absolute;
  bottom: var(--ac-space-2, 0.5rem);
  right: var(--ac-space-3, 0.75rem);
  font-family: var(--ac-font-mono, monospace);
  font-size: var(--ac-text-label, 0.7rem);
  color: var(--ac-on-surface-dim, #888);
  opacity: 0.6;
  pointer-events: none;
}
</style>
