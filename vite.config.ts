import { defineConfig, type Plugin } from 'vite'

// Dev-server half of the live-terminal addon: a WebSocket endpoint at /__pty
// that spawns real PTYs. See PROTOCOL.md for the wire contract.
//
// Sessions are shared: every connection carries a session id (derived from the
// command it wants), and connections with the same id attach to the same PTY.
// That is what makes the presenter tab and the audience tab show the same
// shell, and what keeps a session's scrollback alive while the presenter
// navigates between slides. A session only dies when its process exits, when
// it has had no clients for LINGER_MS, or when the dev server stops.
//
// `ws` and `node-pty` are loaded lazily inside configureServer, never at the
// top of this file. vite.config.ts is also evaluated by `slidev build` and
// `slidev export`, and node-pty is a native module whose install can break
// (wrong Node ABI, missing toolchain). `apply: 'serve'` keeps the hook out of
// builds; the lazy imports keep a broken node-pty from breaking module load.

const LINGER_MS = 30 * 60 * 1000
const BUFFER_CAP = 256 * 1024

interface Session {
  pty: any
  clients: Set<any>
  buffer: string[]
  bufBytes: number
  dead: boolean
  lingerTimer?: ReturnType<typeof setTimeout>
}

function ptyServer(): Plugin {
  return {
    name: 'pty-server',
    apply: 'serve',
    async configureServer(server) {
      const { WebSocketServer } = await import('ws')
      // node-pty is CJS; depending on the interop it surfaces either as the
      // namespace itself or under `default`.
      const ptyMod: any = await import('node-pty')
      const spawn: typeof import('node-pty').spawn =
        ptyMod.spawn ?? ptyMod.default?.spawn

      const wss = new WebSocketServer({ noServer: true })
      const sessions = new Map<string, Session>()

      const destroySession = (sid: string) => {
        const s = sessions.get(sid)
        if (!s)
          return
        sessions.delete(sid)
        clearTimeout(s.lingerTimer)
        if (!s.dead) {
          try {
            s.pty.kill()
          } catch {}
        }
        for (const c of s.clients) {
          try {
            c.close()
          } catch {}
        }
      }

      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        if (url.pathname !== '/__pty') return // leave Vite's HMR upgrade alone

        // This endpoint is arbitrary command execution on the presenter's
        // machine. That is acceptable only because it exists on the dev
        // server, locally. The origin check stops any random web page open in
        // the presenter's browser from connecting cross-origin: browsers
        // always send Origin on WebSocket upgrades, and it must match the
        // host we are actually serving on (or be localhost).
        const origin = req.headers.origin
        if (origin) {
          let ok = false
          try {
            const originHost = new URL(origin).hostname
            const reqHost = (req.headers.host ?? '').split(':')[0]
            ok =
              originHost === reqHost ||
              originHost === 'localhost' ||
              originHost === '127.0.0.1'
          } catch {
            ok = false
          }
          if (!ok) {
            socket.destroy()
            return
          }
        }

        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      })

      // Frames (mirrored from PROTOCOL.md; the same block lives in the
      // component):
      //   client -> server: text JSON
      //     { type: 'input', data: '<utf-8 keystrokes>' }
      //     { type: 'resize', cols: <int>, rows: <int> }
      //   server -> client:
      //     binary frames: raw PTY output bytes (attaching clients first get
      //       the session's buffered scrollback the same way)
      //     text frames: JSON control
      //       { type: 'exit', exitCode: <int> }  process exited; socket stays
      //         open so a restart can reuse it
      //       { type: 'restart' }                another client respawned the
      //         session; reset the terminal, new output follows
      wss.on('connection', (ws: any, req: any) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const cmd = url.searchParams.get('cmd') ?? ''
        const cols = parseInt(url.searchParams.get('cols') ?? '', 10) || 80
        const rows = parseInt(url.searchParams.get('rows') ?? '', 10) || 24
        const cwd = url.searchParams.get('cwd') || server.config.root
        const sid = url.searchParams.get('sid') || `${cwd}|${cmd}`

        const spawnPty = () => {
          // Running through `$SHELL -l -c "<cmd>"` sidesteps arg-splitting on
          // the server and inherits the presenter's login environment (PATH,
          // version managers, aliases from login rc files).
          const shell = process.env.SHELL || 'zsh'
          const args = cmd ? ['-l', '-c', cmd] : ['-l']
          return spawn(shell, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: process.env as Record<string, string>,
          })
        }

        const wire = (s: Session) => {
          // PTY output goes out as binary frames; onData yields strings, and
          // Buffer.from makes ws send binary, which is how the client tells
          // raw output apart from JSON control (text) frames.
          s.pty.onData((data: string) => {
            s.buffer.push(data)
            s.bufBytes += data.length
            while (s.bufBytes > BUFFER_CAP && s.buffer.length > 1)
              s.bufBytes -= s.buffer.shift()!.length
            for (const c of s.clients) {
              if (c.readyState === c.OPEN) c.send(Buffer.from(data))
            }
          })
          s.pty.onExit(({ exitCode }: { exitCode: number }) => {
            s.dead = true
            for (const c of s.clients) {
              try {
                c.send(JSON.stringify({ type: 'exit', exitCode }))
              } catch {}
            }
          })
        }

        let session = sessions.get(sid)
        if (!session) {
          let pty
          try {
            pty = spawnPty()
          } catch (err) {
            // A failed spawn must not take the whole dev server down; report
            // it into the terminal and close like an exit.
            try {
              ws.send(Buffer.from(`failed to spawn: ${err instanceof Error ? err.message : err}\r\n`))
              ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }))
              ws.close()
            } catch {}
            return
          }
          session = { pty, clients: new Set(), buffer: [], bufBytes: 0, dead: false }
          sessions.set(sid, session)
          wire(session)
        } else if (session.dead) {
          // The process exited and a client reconnected: respawn in place and
          // tell everyone else still attached to reset their terminal.
          try {
            session.pty = spawnPty()
          } catch (err) {
            try {
              ws.send(Buffer.from(`failed to spawn: ${err instanceof Error ? err.message : err}\r\n`))
              ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }))
              ws.close()
            } catch {}
            return
          }
          session.dead = false
          session.buffer = []
          session.bufBytes = 0
          wire(session)
          for (const c of session.clients) {
            try {
              c.send(JSON.stringify({ type: 'restart' }))
            } catch {}
          }
        }

        const s = session
        clearTimeout(s.lingerTimer)
        s.clients.add(ws)

        // Late joiners (the audience tab, a slide revisited) get the
        // scrollback replayed before the live stream continues.
        if (s.buffer.length)
          ws.send(Buffer.from(s.buffer.join('')))

        ws.on('message', (raw: unknown, isBinary: boolean) => {
          if (isBinary) return
          try {
            const msg = JSON.parse(String(raw))
            if (s.dead) return
            if (msg.type === 'input' && typeof msg.data === 'string') {
              s.pty.write(msg.data)
            } else if (msg.type === 'resize') {
              const c = Number(msg.cols)
              const r = Number(msg.rows)
              if (Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0) {
                try {
                  s.pty.resize(c, r)
                } catch {}
              }
            }
          } catch {} // ignore malformed frames
        })

        const detach = () => {
          s.clients.delete(ws)
          if (s.clients.size === 0) {
            if (s.dead) {
              destroySession(sid)
            } else {
              clearTimeout(s.lingerTimer)
              s.lingerTimer = setTimeout(() => destroySession(sid), LINGER_MS)
            }
          }
        }
        ws.on('close', detach)
        ws.on('error', detach)
      })

      // Vite restarts the server when this config file changes; kill any
      // shells still running so restarts don't leak processes.
      server.httpServer?.on('close', () => {
        for (const sid of [...sessions.keys()])
          destroySession(sid)
      })
    },
  }
}

export default defineConfig({
  plugins: [ptyServer()],
})
