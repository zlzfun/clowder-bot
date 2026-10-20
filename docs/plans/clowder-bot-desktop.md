# Clowder Bot desktop validation

Accepted 2026-10-19: independent Electron product, shared Clowder runtime and canonical chat, plugin-owned colleagues. Main interaction is an enduring conversation with a colleague, not a task dashboard. Prior implementation: [native colleague validation](clowder-bot-native-colleague-validation.md).

Before: open Console, choose colleague mode, configure each entry, expand CLI output to read replies. After: launch Clowder Bot, choose a colleague, send a message, read their answer directly. Only a missing local execution connection or workspace needs setup. Daily UI has no model parameters, context reset, task dashboard, or diagnostic chrome. Errors and requests for action remain visible.

Reference: read-only inspection of installed Grok Bot on 2026-10-19 showed Bot list → conversation → composer, with secondary operations outside the main flow. No private reference conversation is copied to this repository. Use existing design tokens, quiet two-column desktop composition, responsive colleague drawer, visible message body and collapsed execution details.

## Ownership and state

- Electron owns application identity, isolated browser session, owned child processes and persistent `Clowder Bot` data root. No attach to foreign Redis/API/Web, no volatile-store fallback. Startup failure closes owned processes. Normal quit stops API before Redis so plugin shutdown and persistence complete. This product has no tray: closing the last window also quits.
- Host owns the only queue, transcript, identity binding, session chain and authorization. Plugin `dev.clowder.native-colleagues` supplies all colleague names/roles. No hardcoded colleague list, copied transcript, second Agent runner, or permissive ingress.
- Bot shell owns selection/navigation only. Shared thread chat owns socket/history/send/drafts. Shared message presentation gains a bounded conversation appearance; existing output-layout projection separates final text from process evidence. No heuristic guessing that arbitrary tool stdout is a final answer.
- Last colleague is a local presentation preference validated against the current owner catalog. History restores from Host, not a UI cache. Disabled plugin history stays readable, new execution stays blocked.

## Implementation and proof

1. Desktop isolation: RED tests for occupied dedicated port, unavailable durable storage, inherited config pollution and ordered shutdown. Runtime identity works without package build metadata. Product has independent update behavior.
2. Bot product entry: first launch/setup, two colleague selection, restart selection restore, failure/retry and restricted/unavailable states. Reuse existing native binding API and chat plumbing. No generic management navigation in daily UI.
3. Conversation presentation: user/assistant bubbles, final text visible, process record collapsed even during streaming; actionable failure and authorization visible. Regression tests cover original chat and same live/history output.
4. Build actual Electron application, install/enable packed colleague plugin and configure local Codex in Bot data only using existing APIs. Use user-authorized existing machine login, no credential copying or original instance writes.
5. Actual desktop dogfood: two colleagues perform distinct real file tasks; capture identities, session IDs, message hashes and file hashes. Quit application fully, prove owned services exit, reopen and continue both conversations without repeating their private conversation markers. Verify no duplicate messages and unchanged original data paths. Save actual desktop screenshots and independent review.

Architecture cells: thread-chat-surface, bubble-pipeline, thread-navigation, plugin, identity-session; desktop lifecycle is a new consumer of existing Host shutdown/persistence. Map delta: add bounded product consumer, no canonical writer migration.
Canonical sources: `ThreadChatRuntimeProvider`, `ThreadChatSurface`, `useSendMessage`, `useChatHistory`, `ChatMessage`, native-conversations service, Desktop ServiceManager.
Consumer census: `rg -n 'ThreadChatSurface|ThreadChatRuntimeProvider|CliOutputBlock|stopAll|REDIS_URL|CONFIG_ROOT' packages/web/src desktop packages/api/src`.
Claim guards: targeted desktop lifecycle tests, Bot shell/message regressions, existing native conversation tests, full actual quit/reopen evidence. Occupied ports and missing durable storage must fail before accepting work.

Validation commands use Node 24: `node --test desktop/bot-isolation.test.js desktop/service-manager.test.js`, `pnpm --filter @cat-cafe/web exec vitest run <changed focused tests>`, API/Web typechecks and required builds; `pnpm biome check <changed files> --diagnostic-level=error`, `git diff --check`. No claim that normal idle restart proves forced-crash or mid-execution recovery.

## Actual desktop acceptance — 2026-10-20

Installed application: `~/Applications/Clowder Bot.app`, app ID `ai.clowderbot.desktop`. Persistent root: `~/Library/Application Support/Clowder Bot`; browser partition: `persist:clowder-bot`. Dedicated loopback services: Web 5194, API 3194, Redis 6306, preview 4194. The executable bundles Electron, Node and Redis. This is an ad-hoc-signed macOS arm64 prototype, not a notarized public release.

The packed `dev.clowder.native-colleagues` alpha.2 plugin was installed and enabled through the real client manager. The client connected the existing local Codex login using the existing member API (`clientId: openai`, builtin `accountRef: codex`, inherited default model). Both colleagues were bound through the native directory picker to the Bot-owned workspace. No original instance configuration or storage was edited; no new credentials were copied.

Both initial tasks and both continuation prompts were sent through the actual Electron composer. Read-only API snapshots independently verified the resulting canonical state; no synthetic assistant response or alternate runner was used.

| Acceptance | Actual evidence |
| --- | --- |
| Independent client, default colleague chat | Launch restored 青禾 directly at its original thread route; [native UI](evidence/clowder-bot-desktop/qinghe-restored.jpg), [AX state](evidence/clowder-bot-desktop/qinghe-restored-ax.txt) |
| Plugin-owned two colleagues | Separate catIds, threadIds and provider session IDs in [before-quit.json](evidence/clowder-bot-desktop/before-quit.json); plugin business source remains in the plugin repository |
| Real implementation task | 松果 wrote and ran [summary.py](evidence/clowder-bot-desktop/summary.py), producing [summary.json](evidence/clowder-bot-desktop/summary.json): 7 records, 27 hours, done/doing/todo = 5/9/13 hours |
| Independent verification | 青禾 read the three inputs, independently recalculated and wrote [review.md](evidence/clowder-bot-desktop/review.md); all three input hashes remained unchanged |
| Bubbles and folded execution | Final text is readable without opening CLI output; [松果 screenshot](evidence/clowder-bot-desktop/songguo-restored.jpg). Actual expand/collapse exposed tool records and execution metadata: [expanded AX](evidence/clowder-bot-desktop/execution-expanded-ax.txt) |
| Full quit | App menu → 退出 Clowder Bot. Electron, renderer, GPU, network, API, Web, Redis and observed plugin PIDs exited; all three dedicated ports stopped listening. API/Redis exit 0, AOF fsync and final snapshot observed: [quit proof](evidence/clowder-bot-desktop/quit-proof.json) |
| Reopen recovery | [Before](evidence/clowder-bot-desktop/before-quit.json) and [after](evidence/clowder-bot-desktop/after-reopen.json) compare byte-for-byte equal: plugin instance, bindings, all messages/content hashes, provider sessions and four file hashes |
| Continue both conversations | Without repeating answers, 松果 recalled 松林-1020 and summary.py/summary.json; 青禾 recalled 青叶-1020 and review.md. Same original provider sessions, exactly one new user/assistant pair each, files unchanged: [continued.json](evidence/clowder-bot-desktop/continued.json) |

### Quality gate and independent review

Risk: behavior = new product entry and presentation; data = isolated durable lifecycle/recovery; security = strict native binding and owned loopback processes; contract = existing chat/member/plugin consumers; irreversible = none (no migration or deletion).

- Final desktop tests: 15 passed, including occupied-port refusal, owned listener proof, no memory fallback, environment isolation and ordered/idempotent quit.
- Final focused UI tests: 17 passed across BotShell, BotSetup, native reply projection and execution-layer identity/state. Existing native directory/shell tests also passed earlier in this slice.
- Web production build, TypeScript checks and two production cache-policy tests passed. API and MCP builds passed. Existing lint/Browserslist warnings are not hidden as new failures.
- Real first-use testing found missing native client/account binding fields. Fixed the setup adapter to use the actual member contract and verified successful one-click creation. Review found foreground-store synchronization, canonical execution recovery visibility, process readiness ownership, setup reachability and cross-thread stale confirmation issues; each was fixed, covered by targeted regressions and independently re-reviewed. No open P1/P2 findings remain.
- Architecture maps identify BotShell as a bounded consumer, not another history, queue or Agent authority. The inherited skill command `check:architecture-ownership` is absent in this upstream revision; map changes were inspected directly. No matching Bot/colleague `.pen` exists; actual native UI is the design evidence.
- This checkout has no `origin/main`; inherited scanners must use the real stacked baseline `e3b04ca6c46abd5ad5ee611f7c34d8bad397b663`. Their initial default invocation was inapplicable, not counted as a passing scan.
- Evidence is under this document's dedicated directory. Screenshots contain only synthetic demo tasks and their outputs.

### Observed prototype limits

Acceptance proves normal idle full-app quit/reopen and subsequent continuation. It does not prove forced crash or mid-execution recovery. Isolated listener ownership currently fails closed outside macOS; other platforms are not claimed supported. Plugin package replacement still requires an explicit binding migration, inherited from the native MVP.

Daily navigation has no model settings, context reset or task dashboard. The shared renderer still shows some upstream conventions (delivery receipts, cat avatars and model-generated/Host signatures, sometimes duplicated). They remain visible in the actual screenshots; this validation does not claim final visual polish. Execution errors remain inspectable even after the Agent corrects them. The selected workspace is an execution binding, not an added filesystem sandbox.

## Close gate

```yaml
close_gate_report:
  feature_id: clowder-bot-independent-desktop-mvp
  spec_path: docs/plans/clowder-bot-desktop.md
  report_date: 2026-10-20
  ac_matrix:
    - {ac_id: independent-client-shared-kernel, status: met, evidence: 'desktop/main.js + BotShell.tsx', resolution: null}
    - {ac_id: plugin-owned-two-colleagues, status: met, evidence: 'evidence/clowder-bot-desktop/before-quit.json', resolution: null}
    - {ac_id: native-bubbles-collapsed-details, status: met, evidence: 'evidence/clowder-bot-desktop/songguo-restored.jpg', resolution: null}
    - {ac_id: isolated-app-and-data, status: met, evidence: 'desktop/bot-isolation.test.js', resolution: null}
    - {ac_id: real-file-tasks, status: met, evidence: 'evidence/clowder-bot-desktop/review.md', resolution: null}
    - {ac_id: full-quit-reopen-continuation, status: met, evidence: 'evidence/clowder-bot-desktop/continued.json', resolution: null}
```
