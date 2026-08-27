#!/bin/bash
set -e

# Run from inside the repo: cd "/Users/user/claude/Projects/bedtime-lockout" && ./create_issues.sh
# Requires: gh auth login (already done if you created the repo with gh)

gh label create v1 --color "0E8A16" --description "Needed for first working version" --force
gh label create v2 --color "1D76DB" --description "Deferred / future enhancement" --force
gh label create electron --color "5319E7" --force
gh label create gatekeeper --color "B60205" --force
gh label create research --color "FBCA04" --force
gh label create "decision-needed" --color "D93F0B" --force
gh label create "bug-risk" --color "E99695" --force
gh label create data --color "C2E0C6" --force
gh label create deferred --color "BFDADC" --force

gh issue create --title "Always-on-top + focus-grab reliability on macOS" \
  --body "Determine the best Electron approach for a reliable always-on-top, focus-grabbing overlay window on current macOS. Test how robust it actually is against alt-tab and force-quit attempts — this is the core mechanism the whole lockout depends on, so it needs real-world validation, not just defaults." \
  --label "v1,electron,research"

gh issue create --title "claude -p multi-turn session handling" \
  --body "Figure out the best way to maintain conversation context across negotiation turns with claude -p — whether via session/continue flags or by manually replaying message history on each call. Needs to support the askGatekeeper(messages) -> reply abstraction described in SPEC.md." \
  --label "v1,gatekeeper,research"

gh issue create --title "Fail-open vs. fail-closed when claude -p is unreachable" \
  --body "Decide and implement behavior when claude -p can't be reached (not logged in, no network, CLI error). Fail open (let the user through) or fail closed (overlay stays up with a static message)? Needs a decision once this edge case is reachable in testing." \
  --label "v1,gatekeeper,decision-needed"

gh issue create --title "Native notifications + idle/activity detection permissions" \
  --body "Identify the macOS APIs/permissions needed for (a) native notifications from an Electron app for the countdown, and (b) activity/idle detection used by the late-night escalation trigger." \
  --label "v1,electron,research"

gh issue create --title "Triggering real system sleep + detecting wake events" \
  --body "Determine how to reliably trigger actual system sleep (not just display sleep) from Electron on macOS, and how to detect wake-from-sleep events (e.g. powerMonitor) to drive the quick-wake re-lock check." \
  --label "v1,electron,research"

gh issue create --title "Persisting timers across system sleep" \
  --body "A scheduled re-lock timer (grace period, quick-wake window) needs to survive the Mac actually sleeping and fire correctly relative to wall-clock time on wake, not elapsed app runtime. Figure out the right mechanism." \
  --label "v1,electron,research"

gh issue create --title "Persisting in-flight lockout state across crash/reboot" \
  --body "Active lockout state and pending re-lock timers must be persisted to disk and reconstructed on app startup — not held only in memory. Otherwise an app crash or system reboot becomes an unintended way to escape a pending re-lock." \
  --label "v1,data,bug-risk"

gh issue create --title "Idle-gap tolerance for continuous-activity detection" \
  --body "Define what counts as 'continuous activity' for the late-night escalation trigger — specifically whether brief idle gaps (stepping away for a few minutes) reset the continuous-use clock, and what the tolerance should be." \
  --label "v1,decision-needed"

gh issue create --title "Quick-wake re-lock must catch near-instant sleeps" \
  --body "Ensure the quick-wake re-lock check fires on any wake within the configured window regardless of how long the sleep actually lasted — including near-instant sleep/wake cycles, which are trivially easy to trigger on a Mac and shouldn't be treated as a 'real' sleep that resets suspicion." \
  --label "v1,bug-risk"

gh issue create --title "Cap negotiated grace periods by strictness setting" \
  --body "The gatekeeper sets a re-lock grace period based on what the user argues for ('10 more minutes'), but this needs an upper bound tied to the strictness setting (e.g. high strictness caps grace at 15 min regardless of what's negotiated) — otherwise grace-period negotiation becomes a loophole for unlocking hours at a time." \
  --label "v1,gatekeeper,bug-risk"

gh issue create --title "[Deferred] Wearable/health app integration" \
  --body "Integrate real sleep data (Oura, Apple Health, Fitbit, Whoop) once local self-logging is in place. Data schema should already anticipate this." \
  --label "v2,deferred"

gh issue create --title "[Deferred] Auto-scaling gatekeeper strictness from history" \
  --body "Automatically scale negotiation strictness based on logged override/lateness patterns, rather than the v1 manually-set strictness level." \
  --label "v2,deferred"

gh issue create --title "[Deferred] Track which negotiation tactics actually work" \
  --body "Log which arguments/tactics led to successful negotiated unlocks (not just outcome/method) and feed that back into future gatekeeper system prompts so it can reuse what's worked before." \
  --label "v2,deferred"

gh issue create --title "[Deferred] OS-level kiosk lock (beyond focus-grabbing overlay)" \
  --body "Explore true OS-level lock (kiosk mode / accessibility APIs) as a stronger alternative to the always-on-top overlay, if the overlay proves too easy to bypass in practice." \
  --label "v2,deferred,research"

gh issue create --title "[Deferred] Cross-platform (Windows) support" \
  --body "Port beyond macOS if/when desired. Not in scope until v1 is proven out." \
  --label "v2,deferred"

echo "Done — 15 issues created in whaibot/bedtime-lockout."
