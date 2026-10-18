# Clowder Bot native colleague validation

User-authorized scope (2026-10-18): fork upstream into `zlzfun/clowder-bot`; implement only necessary generic Host seams, keep colleague business in the plugin repository, reuse native chat and local Agent execution, prove two colleagues + real file tasks + restart recovery, then show the actual Console.

Baseline: upstream `4b5dc96b515787fd8c2fc76fb398fe8c289b36fd`. Host worktree: `/private/tmp/cat-cafe-clowder-bot`; plugin worktree: `/private/tmp/clowder-bot-plugins`. No existing runtime config or user storage is modified. A dedicated persistent development instance is used for verification.

## Implementation contract

- Existing supervised MCP contributions carry a versioned, data-only `clowder_native_conversations_v1` descriptor. This reuses installation, package integrity and plugin process lifecycle; no new same-DOM plugin code or webpage server.
- Generic Host endpoints discover descriptors and let the authenticated local owner bind an entity to an existing execution template and a selected workspace. A descriptor cannot self-authorize an execution, select another owner's thread, or supply command/env/credentials.
- Host stores accepted identity/binding metadata, not a second transcript or queue. Stable distinct catIds and relationshipKeys feed the existing AgentRegistry and SessionChain. Native composer remains the only first-version execution ingress.
- Console contributes a directory in the existing shell, opens `/thread/:id`, and continues using ChatContainer/ThreadChatSurface. Names, roles and templates come exclusively from the plugin.
- Disabled/crashed plugins deny fresh dispatch; historical identity remains readable. Closing the view never cancels accepted work. Restart restores the same binding and canonical Host history; existing dispatch recovery determines interrupted runs, with no blind replay.

## Verification

Behavior tests: descriptor validation, identity separation, owner/thread/workspace binding, idempotent concurrent open and restart, disabled authority, historical author retention. Native UI tests: actual directory navigation/setup/error and original chat reuse. Integration: packed plugin installed through Host manager, two real Agent file tasks, browser reload + API restart against persistent storage, same identities/history, no iframe. Independent review before completion.

## Ownership

Cells: plugin, identity-session, thread-navigation, thread-chat-surface; consume dispatch and bubble-pipeline. Ownership maps updated with the new bounded consumers. No plugin transcript, runner, queue or unread authority. First implementation supports already-configured local Codex templates; arbitrary providers, autonomous sends, provider-native control actions and group orchestration are outside this validation.

## Progress

- [x] Personal Host and plugin forks created.
- [x] Current upstream baseline checked in isolated worktrees.
- [x] Generic Host seams + 11 behavioral/API tests.
- [x] Plugin descriptor package + fresh packed consumer verification (self-contained alpha.2).
- [x] Native Console directory and setup; 39 targeted UI tests and Web typecheck.
- [x] Real file tasks + persistent restart recovery.
- [x] Independent review + published draft source and user-visible preview.

## Acceptance evidence (2026-10-18)

Code acceptance HEAD: `085939d1`. The personal forks and draft PRs are [Host](https://github.com/zlzfun/clowder-bot/pull/1) and [plugin](https://github.com/zlzfun/clowder-ai-plugins/pull/1). No upstream merge or stable release is claimed.

The user authorized a local Codex template in this isolated instance, then explicitly authorized initializing its missing template path and normally restarting its API. The public fork template is linked from the isolated state directory; both startup and the existing member API now resolve that directory. The member was created through `POST /api/cats`, using the existing native Codex login and its default model. Existing user instance configuration was not changed.

Dedicated preview: Console `http://localhost:5192`, API `3192`, Redis `6308`, persistent data `/private/tmp/clowder-bot-state`, task workspace `/private/tmp/clowder-bot-workspace`. Source cwd is `/private/tmp/cat-cafe-clowder-bot`. Processes use bounded launchd preview leases.

| User journey | Observed result | Evidence |
| --- | --- | --- |
| Open two colleagues | Native directory shows 松果 and 青禾; setup uses existing template and DirectoryBrowser | [Directory](evidence/clowder-bot/console-directory.jpg) |
| Send and execute | Existing composer dispatched real local Codex CLI calls in the selected workspace | [DOM assertion](evidence/clowder-bot/native-dom.json): one composer and zero iframes |
| 松果 file task | Read 8 tickets, wrote and ran a standard-library Python script; result is 8 tickets, 21 hours, done/doing/todo = 3/2/3, high priority = 3 | [Script](evidence/clowder-bot/summarize.py), [result](evidence/clowder-bot/summary.json), [input](evidence/clowder-bot/tickets.csv) |
| 青禾 independent task | Read the original data, script and result; recalculated, wrote a report; all three input hashes unchanged | [Actual report](evidence/clowder-bot/review.md) |
| Normal API restart | Same plugin instance, catIds, threadIds, workspaces, message IDs/content hashes, distinct provider session IDs and all four files | [Before](evidence/clowder-bot/before-restart.json) and [after](evidence/clowder-bot/after-restart.json) are exactly equal |
| Continue after restart | Both returned their own name, accepted conversation marker and delivered file names; CLI invocation logs pass the original session IDs | [Replies](evidence/clowder-bot/resumed-replies.json), [session events](evidence/clowder-bot/cli-session-events.json), [Console](evidence/clowder-bot/console-restored.jpg) |

The first 青禾 marker was only in a failed, later stopped queue input. Its first follow-up honestly reported that the marker was unavailable. The marker was then explicitly accepted in a successful turn, followed by another normal restart and exact snapshot comparison; 青禾 correctly recalled it afterward. This does not count the failed input as successfully delivered context.

### Bugs found and fixed by actual use

- OAuth members may leave the model blank. Tool capability projection rejected that blank `modelFamily` before CLI spawn. Normalize only that projection to the existing `provider-default` identity; keep CLI model inheritance and strict attestation schema unchanged. The new regression reproduced the exact Zod failure before the fix.
- An expired browser session could enter the ordinary compatibility path, persist a native message, then fail strict execution authorization repeatedly. Bound native threads now return HTTP 401 before message/draft/queue effects, letting existing `apiFetch` refresh authentication and retry. The regression observed HTTP 202 before the fix, then proved HTTP 401 with zero messages/queue rows and one strict, idempotent accepted retry afterward. Full execution authorization remains enforced.

Both fixes received independent read-only review with no remaining P1/P2/P3. The stopped failure record and initial error history were not purged.

### Verification and scope of the claim

- API TypeScript build passed. Native behavior/API tests: 11 passed; composer/message regressions including the new auth case: 62 passed; tool capability projection: 10 passed. Existing browser session refresh tests: 9 passed.
- Prior implementation validation remains recorded: 39 native shell/UI tests and Web typecheck, plus 189 existing capability/member/L0 regressions. Self-contained plugin archive passed a fresh extracted stdio consumer and installed through the real manager.
- Biome error-level checks and `git diff --check` passed. Capability tips check passed with nine existing source-reference warnings; this prototype is `tips_exempt`: its visible directory is its direct entry, and it is not a stable feature announcement.
- Architecture maps cover plugin, identity-session, thread-navigation and thread-chat-surface. The skill's `check:architecture-ownership` command is absent in this upstream revision; map coverage was inspected directly. No duplicate transcript, queue or runner was added.
- Fallback scanner flagged validation predicates, empty view defaults and bounded error reporting in the new files. These do not select alternate owners, identities, workspaces or execution routes. Invalid binding/authority fails closed; storage errors other than an absent initial snapshot propagate. Removing those branches would either hide failure or break first-open rendering. Independent review covered these boundaries.
- No matching `.pen` design exists in this checkout: visual acceptance used the actual Console, including narrow-panel navigation. Media evidence is under this document's evidence directory, not repository root.

## Close gate (MVP)

```yaml
close_gate_report:
  feature_id: clowder-bot-native-colleagues-mvp
  spec_path: docs/plans/clowder-bot-native-colleague-validation.md
  head_sha: 085939d1
  report_date: 2026-10-18
  ac_matrix:
    - ac_id: personal-forks
      status: met
      evidence: [{kind: pr, ref: 'https://github.com/zlzfun/clowder-bot/pull/1'}]
      resolution: null
    - ac_id: generic-host-plugin-business
      status: met
      evidence: [{kind: pr, ref: 'https://github.com/zlzfun/clowder-ai-plugins/pull/1'}]
      resolution: null
    - ac_id: native-chat-two-local-agents
      status: met
      evidence: [{kind: screenshot, ref: 'evidence/clowder-bot/console-directory.jpg'}]
      resolution: null
    - ac_id: real-file-tasks
      status: met
      evidence: [{kind: doc, ref: 'evidence/clowder-bot/review.md'}]
      resolution: null
    - ac_id: normal-restart-and-continuation
      status: met
      evidence: [{kind: doc, ref: 'evidence/clowder-bot/resumed-replies.json'}]
      resolution: null
```

## Deliberate MVP limits

Persistent Host storage is required. Bindings fix workspace and execution template at first acceptance. Plugin package replacement requires a future explicit migration/rebinding contract. Provider-native review, goal, fork, compaction and realtime controls are not exposed on plugin identities until they can consume the same authority contract. Disabled plugins retain readable author identities/history and deny new invocations. The selected workspace is an execution binding, not a new filesystem sandbox.

The actual UI still exposes the Host's task-oriented CLI Output disclosure, model/usage metadata and environment-sync banner. Final replies can be read by expanding the existing output card; the colleague directory and conversation navigation are native, but the result is not yet a lightweight messenger experience. This is an observed product limitation of the reuse-first prototype, not hidden behind a second webpage.

Acceptance covers idle normal API shutdown/start with persistent Redis. It does not prove mid-execution continuation or forced-crash recovery. The managed preview stop command kills the full process group including MCP children; existing plugin supervision treats that as a crash and can require explicit re-enable. Normal API SIGTERM executes Host close hooks and recovers the enabled plugin automatically.
