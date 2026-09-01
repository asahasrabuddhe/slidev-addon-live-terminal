import { defineConfig, type Plugin } from 'vite'

// Dev-server half of the live-terminal addon: a WebSocket endpoint at /__pty
// that spawns real PTYs. See PROTOCOL.md for the wire contract.
//
// `ws` and `node-pty` are loaded lazily inside configureServer, never at the
// top of this file. vite.config.ts is also evaluated by `slidev build` and
// `slidev export`, and node-pty is a native module whose install can break
// (wrong Node ABI, missing toolchain). `apply: 'serve'` keeps the hook out of
// builds; the lazy imports keep a broken node-pty from breaking module load.
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
      const livePtys = new Set<{ kill: () => void }>()

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
      //     binary frames: raw PTY output bytes
      //     text frames: JSON control, only { type: 'exit', exitCode: <int> },
      //       after which the server closes the socket
      wss.on('connection', (ws: any, req: any) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const cmd = url.searchParams.get('cmd') ?? ''
        const cols = parseInt(url.searchParams.get('cols') ?? '', 10) || 80
        const rows = parseInt(url.searchParams.get('rows') ?? '', 10) || 24
        const cwd = url.searchParams.get('cwd') || server.config.root

        // Running through `$SHELL -l -c "<cmd>"` sidesteps arg-splitting on
        // the server and inherits the presenter's login environment (PATH,
        // version managers, aliases from login rc files).
        const shell = process.env.SHELL || 'zsh'
        const args = cmd ? ['-l', '-c', cmd] : ['-l']

        // A failed spawn must not take the whole dev server down; report it
        // into the terminal (binary output frame) and close like an exit.
        let ptyProc: ReturnType<typeof spawn>
        try {
          ptyProc = spawn(shell, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: process.env as Record<string, string>,
          })
        } catch (err) {
          try {
            ws.send(Buffer.from(`failed to spawn ${shell}: ${err instanceof Error ? err.message : err}\r\n`))
            ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }))
            ws.close()
          } catch {}
          return
        }
        livePtys.add(ptyProc)
        let killed = false
        const killPty = () => {
          if (killed) return
          killed = true
          livePtys.delete(ptyProc)
          try {
            ptyProc.kill()
          } catch {}
        }

        // PTY output goes out as binary frames; onData yields strings, and
        // Buffer.from makes ws send binary, which is how the client tells raw
        // output apart from JSON control (text) frames.
        ptyProc.onData((data: string) => {
          if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data))
        })

        ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
          killed = true
          livePtys.delete(ptyProc)
          try {
            ws.send(JSON.stringify({ type: 'exit', exitCode }))
          } catch {}
          try {
            ws.close()
          } catch {}
        })

        ws.on('message', (raw: unknown, isBinary: boolean) => {
          if (isBinary) return
          try {
            const msg = JSON.parse(String(raw))
            if (msg.type === 'input' && typeof msg.data === 'string') {
              ptyProc.write(msg.data)
            } else if (msg.type === 'resize') {
              const c = Number(msg.cols)
              const r = Number(msg.rows)
              if (Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0) {
                try {
                  ptyProc.resize(c, r)
                } catch {}
              }
            }
          } catch {} // ignore malformed frames
        })

        ws.on('close', killPty)
        ws.on('error', killPty)
      })

      // Vite restarts the server when this config file changes; kill any
      // shells still running so restarts don't leak processes.
      server.httpServer?.on('close', () => {
        for (const p of livePtys) {
          try {
            p.kill()
          } catch {}
        }
        livePtys.clear()
      })
    },
  }
}

export default defineConfig({
  plugins: [ptyServer()],
})
