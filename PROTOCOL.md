# WebSocket protocol between LiveTerminal.vue and the pty-server vite plugin

Endpoint: `ws(s)://<location.host>/__pty` on the Slidev dev server (dev only; the
plugin is `apply: 'serve'`).

## Sessions

PTYs are shared sessions, keyed by `sid` (defaulting to `cwd|cmd`). Every
connection with the same key attaches to the same PTY: all attached clients
receive its output, any of them may write input, and a client attaching to a
running session first receives the buffered scrollback (capped at 256KB) as
one binary frame. This is what keeps the presenter tab and the audience tab
showing the same shell, and what preserves a session while the presenter
navigates between slides.

A session dies when its process exits and no client remains, when it has had
no clients for 30 minutes, or when the dev server stops. Reconnecting to a
session whose process has exited respawns it in place; other attached clients
are told to reset via the `restart` control frame.

## Connection query parameters

- `cmd` — optional command string. Empty/absent spawns a plain login shell.
  Non-empty runs via `$SHELL -l -c "<cmd>"` (no arg-splitting server-side).
- `cols`, `rows` — initial PTY size (integers; the client fits the terminal
  before connecting). Later resizes from any client apply to the shared PTY.
- `cwd` — optional working directory for the spawned process.
- `sid` — optional explicit session key, to force separate sessions for the
  same command.

The server rejects upgrades whose `Origin` header is not the dev server's own
host or localhost.

## Frames

Client → server: **text** frames, JSON:

- `{ "type": "input", "data": "<utf-8 keystrokes>" }`
- `{ "type": "resize", "cols": <int>, "rows": <int> }`

Server → client, disambiguated by frame type:

- **Binary** frames: raw PTY output bytes (scrollback replay included). Write
  straight to xterm.
- **Text** frames: JSON control messages:
  - `{ "type": "exit", "exitCode": <int> }` — the process exited. The socket
    stays open so a later respawn can reach this client.
  - `{ "type": "restart" }` — another client respawned the session; reset the
    terminal, new output follows.

A restart from the client side is simply a new connection with the same key.
