# Initial issue list (from SPEC.md)

Each issue below maps to an open technical question or deferred item in
SPEC.md. Labels suggested in [brackets]. Create these once Claude Code work
begins, so early implementation decisions get tracked against them.

---

### 1. Always-on-top + focus-grab reliability on macOS
[v1, electron, research]

Determine the best Electron approach for a reliable always-on-top,
focus-grabbing overlay window on current macOS. Test how robust it actually
is against alt-tab and force-quit attempts — this is the core mechanism the
whole lockout depends on, so it needs real-world validation, not just
defaults.

---

### 2. `claude -p` multi-turn session handling
[v1, gatekeeper, research]

Figure out the best way to maintain conversation context across negotiation
turns with `claude -p` — whether via session/continue flags or by manually
replaying message history on each call. Needs to support the
`askGatekeeper(messages) -> reply` abstraction described in SPEC.md.

---

### 3. Fail-open vs. fail-closed when `claude -p` is unreachable
[v1, gatekeeper, decision-needed]

Decide and implement behavior when `claude -p` can't be reached (not logged
in, no network, CLI error). Fail open (let the user through) or fail closed
(overlay stays up with a static message)? Needs a decision once this edge
case is reachable in testing.

---

### 4. Native notifications + idle/activity detection permissions
[v1, electron, research]

Identify the macOS APIs/permissions needed for (a) native notifications from
an Electron app for the countdown, and (b) activity/idle detection used by
the late-night escalation trigger.

---

### 5. Triggering real system sleep + detecting wake events
[v1, electron, research]

Determine how to reliably trigger actual system sleep (not just display
sleep) from Electron on macOS, and how to detect wake-from-sleep events
(e.g. `powerMonitor`) to drive the quick-wake re-lock check.

---

### 6. Persisting timers across system sleep
[v1, electron, research]

A scheduled re-lock timer (grace period, quick-wake window) needs to survive
the Mac actually sleeping and fire correctly relative to wall-clock time on
wake, not elapsed app runtime. Figure out the right mechanism.

---

### 7. Persisting in-flight lockout state across crash/reboot
[v1, data, bug-risk]

Active lockout state and pending re-lock timers must be persisted to disk
and reconstructed on app startup — not held only in memory. Otherwise an app
crash or system reboot becomes an unintended way to escape a pending re-lock.

---

### 8. Idle-gap tolerance for continuous-activity detection
[v1, decision-needed]

Define what counts as "continuous activity" for the late-night escalation
trigger — specifically whether brief idle gaps (stepping away for a few
minutes) reset the continuous-use clock, and what the tolerance should be.

---

### 9. Quick-wake re-lock must catch near-instant sleeps
[v1, bug-risk]

Ensure the quick-wake re-lock check fires on any wake within the configured
window regardless of how long the sleep actually lasted — including
near-instant sleep/wake cycles, which are trivially easy to trigger on a Mac
and shouldn't be treated as a "real" sleep that resets suspicion.

---

### 10. Cap negotiated grace periods by strictness setting
[v1, gatekeeper, bug-risk]

The gatekeeper sets a re-lock grace period based on what the user argues for
("10 more minutes"), but this needs an upper bound tied to the strictness
setting (e.g. high strictness caps grace at 15 min regardless of what's
negotiated) — otherwise grace-period negotiation becomes a loophole for
unlocking hours at a time.

---

### 11. [Deferred] Wearable/health app integration
[v2, deferred]

Integrate real sleep data (Oura, Apple Health, Fitbit, Whoop) once local
self-logging is in place. Data schema should already anticipate this.

---

### 12. [Deferred] Auto-scaling gatekeeper strictness from history
[v2, deferred]

Automatically scale negotiation strictness based on logged override/lateness
patterns, rather than the v1 manually-set strictness level.

---

### 13. [Deferred] Track which negotiation tactics actually work
[v2, deferred]

Log which arguments/tactics led to successful negotiated unlocks (not just
outcome/method) and feed that back into future gatekeeper system prompts so
it can reuse what's worked before.

---

### 14. [Deferred] OS-level kiosk lock (beyond focus-grabbing overlay)
[v2, deferred, research]

Explore true OS-level lock (kiosk mode / accessibility APIs) as a stronger
alternative to the always-on-top overlay, if the overlay proves too easy to
bypass in practice.

---

### 15. [Deferred] Cross-platform (Windows) support
[v2, deferred]

Port beyond macOS if/when desired. Not in scope until v1 is proven out.

---

## Bulk-create via `gh` CLI

If you want to create all of these at once rather than pasting manually,
save this file's content and run (from inside the repo, with `gh auth`
already set up):

```bash
gh issue create --title "Always-on-top + focus-grab reliability on macOS" \
  --body "Determine the best Electron approach for a reliable always-on-top, focus-grabbing overlay window on current macOS. Test robustness against alt-tab and force-quit." \
  --label "v1,electron,research"

gh issue create --title "claude -p multi-turn session handling" \
  --body "Figure out the best way to maintain conversation context across negotiation turns with claude -p." \
  --label "v1,gatekeeper,research"

# ...repeat per issue above, or ask Claude Code to script this from this file.
```

Note: labels must exist in the repo before `--label` will work
(`gh label create v1`, etc.) or omit `--label` and add them after.
