---
theme: default
addons:
  - '.'
---

# slidev-addon-live-terminal

Addon dev deck. Run `npm run dev` here to exercise the component.

---

<div class="h-100">
  <LiveTerminal />
</div>

---

<!-- /demo.cast 404s until a real recording is dropped into public/ -->

<div class="h-100">
  <LiveTerminal cmd="ls -la && echo done" cast="/demo.cast" />
</div>
