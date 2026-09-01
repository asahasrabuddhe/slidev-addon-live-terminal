# slidev-addon-live-terminal

A live interactive terminal inside Slidev slides. xterm.js in the browser,
node-pty on the dev server, wired over a WebSocket on the dev server's own
port. Includes an asciinema cast fallback for when a live demo dies on stage,
and degrades to a static placeholder in builds and PDF exports.

## Install

```bash
npm install slidev-addon-live-terminal
```

Add the addon to your deck's headmatter:

```yaml
addons:
  - slidev-addon-live-terminal
```

## Usage

```md
<LiveTerminal cmd="podman run --rm -it alpine sh" cast="/casts/demo.cast" />
```

The component fills its container. Give it a sized wrapper, or put it inside
your theme's terminal chrome.

Props:

- `cmd` — command to run via `$SHELL -l -c`. Empty (default) opens a plain
  login shell.
- `cast` — URL of an asciinema `.cast` file (put files in your deck's
  `public/`). Press the fallback key to swap live terminal and recording.
- `mode` — `live` (default) or `cast`.
- `fallbackKey` — key that toggles live/cast, default `f`.
- `fontSize` — default `14`.
- `rows` — fixed row count; by default the terminal fits its container.
- `cwd` — working directory for the spawned process.
- `autoConnect` — default `true`; `false` shows a click-to-start overlay.

While presenting: `f` swaps to the recording, `r` restarts an exited process.

## Behavior notes

- The terminal only connects when its slide becomes active, and only in the
  main slide view and presenter view. The presenter's next-slide preview,
  overview, and print rendering never spawn a PTY.
- Leaving the slide keeps the session alive; it is disposed when the deck
  unloads.
- In production builds and PDF exports there is no dev server, so the
  component shows the cast if one is given, otherwise a styled placeholder.
- The `/__pty` endpoint executes commands as you, on your machine, dev-server
  only. It rejects cross-origin WebSocket upgrades.
