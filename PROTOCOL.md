# WebSocket protocol between LiveTerminal.vue and the pty-server vite plugin

Endpoint: `ws(s)://<location.host>/__pty` on the Slidev dev server (dev only; the
plugin is `apply: 'serve'`).

## Connection query parameters

- `cmd` — optional command string. Empty/absent spawns a plain login shell.
  Non-empty runs via `$SHELL -l -c "<cmd>"` (no arg-splitting server-side).
- `cols`, `rows` — initial PTY size (integers; the client fits the terminal
  before connecting).
- `cwd` — optional working directory for the spawned process.

The server rejects upgrades whose `Origin` header is not the dev server's own
host or localhost.

## Frames

Client → server: **text** frames, JSON:

- `{ "type": "input", "data": "<utf-8 keystrokes>" }`
- `{ "type": "resize", "cols": <int>, "rows": <int> }`

Server → client, disambiguated by frame type:

- **Binary** frames: raw PTY output bytes. Write straight to xterm.
- **Text** frames: JSON control messages. Currently only
  `{ "type": "exit", "exitCode": <int> }`, sent when the process exits; the
  server closes the socket right after.

Closing the socket from either side kills the PTY. A restart is simply a new
connection.
