# Bedtime Lockout

A menu-bar Electron app for macOS that enforces a bedtime by locking your
screen behind a fullscreen, focus-grabbing overlay — dismissible only by
negotiating past an LLM gatekeeper (backed by the Claude Code CLI) or by
using a logged override phrase. Underlying apps and windows are never
touched; whatever you were working on is exactly as you left it once the
lock lifts.

See [SPEC.md](./SPEC.md) for the full design spec and [ISSUES.md](./ISSUES.md)
for tracked work.

## Development

```bash
npm install
npm run dev          # run the app in development
npm test              # unit/DOM tests (vitest)
npm run test:e2e      # Playwright + Electron end-to-end tests
npm run lint           # oxlint
npm run format         # oxfmt
```

## Building

```bash
npm run dist:mac
```

Requires a working Claude Code CLI login (`claude -p`) for the gatekeeper
negotiation to function.
