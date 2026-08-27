# Raw design bundles

The verbatim Claude Design source files —
`Bedtime Lockout.dc.html` (composition), `Overlay.dc.html` (the overlay
component, 6 modes × 3 themes), and `Presence.dc.html` (the animated orb) —
live in the Claude Design project and are re-fetchable on demand rather than
copied here (they depend on the canvas runtime `support.js` and are not runnable
in the app, so the distilled `../DESIGN.md` is the implementation reference).

Re-fetch any of them via the `DesignSync` tool:

- `method: get_file`
- `projectId: 06757bea-31ca-46d4-b259-6651353a7dc5`
- `path:` one of `Bedtime Lockout.dc.html`, `Overlay.dc.html`,
  `Presence.dc.html`, `support.js`
- Visual screenshots: `screenshots/canvas.png`, `screenshots/states.png`

`../DESIGN.md` captures every implementation-relevant detail (theme tokens,
fonts, the six overlay modes with exact copy, the presence orb, settings rows,
strictness caps, and the quick-wake conflict note).
