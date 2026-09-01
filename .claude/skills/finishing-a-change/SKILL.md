---
name: finishing-a-change
description: Use when about to commit or push in this repo, once the code works and `npm run verify` passes — and especially when the change deleted a feature, renamed or removed a field, dropped a setting, or touched anything under src/renderer.
---

# Finishing a change

## Overview

The git hooks prove the code still **works**. They cannot see what the change left **behind**. A change that compiles, passes every test and lints clean can still be half-finished.

These four checks need judgement, so nothing enforces them. Run them after `npm run verify` passes, before writing the commit message.

## 1. Sweep for code the change orphaned

Grep every name you removed or renamed:

```bash
grep -rn "<removed-name>" src tests
```

A deleted feature strands more than its own file. Things that move together in this repo:

| If you removed | Also check |
|---|---|
| A `Port` method | `ports.ts`, its impl in `power.ts`/`notifications.ts`, its fake in `tests/helpers/fakes.ts` |
| A control from a renderer `index.html` | Element lookups in `main.ts`, rules in the matching `.css` |
| A `Settings` field | `DEFAULTS`, `mergeSettings`, the settings renderer, `tests/settings.test.ts` |
| A pure helper | Its only caller may have been the feature you just deleted |

Removing continuous-use escalation from this repo stranded `PowerMonitorPort.getSystemIdleTime`, `scheduler.recompress`, an `input[type="range"]` rule, and a test helper — none of which any tool flagged.

## 2. Sweep for comments the change made stale

Grep the identifiers you touched, in comments as well as code. Under this repo's comment rules a comment naming a field that was renamed or deleted is a **defect**, not untidiness — it actively misleads.

The same escalation removal left `timers.ts` describing `recompress` and `controller.ts` naming `escalation.pollIntervalMs`, both long after those existed.

## 3. Update docs if observable behaviour changed

`README.md`, `SPEC.md`, `ISSUES.md`. Settings fields, tray entries, npm scripts and app behaviour are observable. Internal refactors are not.

## 4. Cover a renderer change with a renderer test

Anything under `src/renderer` gets a test that drives the real HTML, not a look by eye — the settings window is only reachable through the tray, so eyeballing it is expensive and easy to skip.

`tests/settings-renderer.test.ts` is the pattern: read `index.html`, strip to `<body>`, stub the preload bridge on `window`, `await import()` the module.

## Red flags

- "It was a small deletion, nothing else used it" — grep anyway; that is exactly the case that strands helpers
- "The comment is still roughly right" — roughly right is stale
- "It's obviously still correct" — that is a prediction, and greps are cheap
- "Tests pass, so nothing was orphaned" — dead code passes tests by definition

## When not to use

A change that only edits docs, or one that adds a wholly new file touching nothing existing. Checks 1 and 2 have nothing to sweep.
