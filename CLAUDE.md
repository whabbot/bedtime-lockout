Before committing, use the finishing-a-change skill.

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
