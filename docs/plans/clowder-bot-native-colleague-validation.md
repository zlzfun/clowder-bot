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
- [ ] Real file tasks + persistent restart recovery.
- [x] Independent review + published draft source and user-visible preview.

## Current verification evidence

- Host full API build and subsequent TypeScript checks passed; 189 existing capability/member/L0 regression tests also passed. Real L0 subprocess compilation includes the accepted colleague name and role without writing a member catalog.
- Independent review found and closed: template MCP restriction inheritance, strict owner provenance, late workspace/liveness recheck, memory-only recovery rejection, reserved identity namespace, and provider-control bypasses. Final independent scan reported no remaining P1/P2; this is not a substitute for real Agent acceptance.
- Dedicated preview: Console `http://localhost:5192`, API `3192`, Redis `6308`, data `/private/tmp/clowder-bot-state`. All processes are managed launchd previews with bounded leases. Existing user instance untouched.
- Packed plugin `@zlzfun/clowder-native-colleagues@0.1.0-alpha.2` installed and enabled through the real Host manager. Native directory displays 松果 and 青禾. The initial dependency-bearing alpha.1 failed runtime materialization; alpha.2 bundles MCP dependencies and passed a fresh extracted-package stdio client check.
- Browser inspection confirmed one existing composer, a native directory and zero iframes. A normal API SIGTERM/shutdown/restart retained the same plugin instance and automatically restored both directory entries. This verifies plugin lifecycle recovery, not yet post-task conversation recovery.
- The managed preview stop command terminates the entire process group, including MCP children. Existing Host supervision treats that as a plugin crash and requires explicit re-enable. Forced process-group termination is therefore a known recovery limitation, not presented as automatic restart success.
- Pending: the clean Host catalog has no local Codex member. The user was asked for explicit permission to create one only in this isolated instance, because their AGENTS.md requires human action for runtime configuration changes. No actual Agent task or post-task restart recovery is claimed yet.
- Draft source: [Host PR](https://github.com/zlzfun/clowder-bot/pull/1), [plugin PR](https://github.com/zlzfun/clowder-ai-plugins/pull/1). No upstream PR or stable release was published.

## Deliberate MVP limits

Persistent Host storage is required. Bindings fix workspace and execution template at first acceptance. Plugin package replacement requires a future explicit migration/rebinding contract. Provider-native review, goal, fork, compaction and realtime controls are not exposed on plugin identities until they can consume the same authority contract. Disabled plugins retain readable author identities/history and deny new invocations. The selected workspace is an execution binding, not a new filesystem sandbox.
