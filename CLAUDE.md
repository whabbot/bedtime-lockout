## Comments

- Don't add unnecessary comments. Add comments where the code is complex or unusual, but do not add comments if the code is easily understandable. Prefer extracting methods to make the code more expressive over adding inline comments.
- Only add comments about things which are necessary to understand the code, the domain or FUTURE features. Do not add comments about features which no longer exist, or about corrections that were made in the process of coding, or about current implementation plans.

Bad example:

```typescript
app.on("window-all-closed", () => {}); // do NOT quit on close in v1
```

This is a meta comment about the current implementation plan. This kind of comment should instead be an issue/work item/plan note and does not belong in the code

Marginal example:

```typescript
/** Serializable activity-tracking state, persisted via Store by a later task. */
export interface ActivityState {
  continuousActiveSinceMs: number | null;
  lastSampleMs: number;
}
```

This is a comment about a future feature, and so is just about acceptable as a TODO. However, it refers to "task" and so is still a meta comment about the current plan. On balance, it would be better to add an issue/work item/plan note with reference to this file + class

Bad example:

```typescript
/**
 * Append-only event log entries (schema version 1). Every variant carries
 * `v: 1` and an optional open `meta?: object` bag so future external/wearable
 * data sources can attach arbitrary data without a schema redesign (#11).
 */
export type LockoutEvent = 
    { v: 1; kind: "override"; at: string; meta?: object }
    | { v: 1; kind: "quickwake"; at: string; sleptMs: number; meta?: object };
```

Here the (#11) refers to a specific implementation task which is completely meaningless outside of the context in which the code was written. Even the reference to "v: 1" is probably over-specific, as this will need to be changed later if the code changes. Instead, we should describe what this is for. We could mention version, but it would be better to say what the purpose of the version is (to allow cache busting?) and under what circumstances the version should be incremented

Bad example:

```typescript
/** Extracts the canonical timestamp (ms since epoch) for any LockoutEvent variant. */
function timestampMs(ev: LockoutEvent): number {
  const iso = ev.kind === "lockout" ? ev.actualAt : ev.at;
  return new Date(iso).getTime();
}
```

This comment is unnecessary - the comment just repeats what the code already says.

## Before every commit

Run `npm run verify` — format, types, unit tests, lint, production build. All
five must pass.

`tsc --noEmit` is the gate that matters most on a change that removes things:
the test suite can go green while a deleted symbol is still referenced, because
the file that referenced it lost its tests in the same change.

Read vitest's tail, not just the pass count. Unhandled rejections report as
`Errors N errors` while every test still passes.

Then the parts no script can check:

- Sweep for code the change orphaned. Grep the names you removed — a deleted
  feature usually strands more than its own file: a port method, a test helper,
  a CSS rule.
- Sweep for comments the change made stale. Grep the identifiers you touched. A
  comment naming a field that was renamed or deleted is a defect under the rules
  above, not untidiness.
- Update README, SPEC or ISSUES if observable behaviour changed.
- Cover a UI change with a renderer test driving the real HTML (see
  `tests/settings-renderer.test.ts`) rather than checking it by eye.

## Before every push

`npm run test:e2e` runs the app for real and is the slowest check, so it sits at
the push boundary rather than the commit one: the `pre-push` hook runs
`npm run verify` and then the end-to-end suite. Run it earlier by hand when a
change to `src/main`, `src/preload` or `src/renderer` looks likely to break it.

`git push --no-verify` skips the hook, for pushes that can't break the app.
