# Project collaboration constraints

## Upstream-first product boundary

- Clowder Bot is a product built on Clowder AI. Maximize direct reuse of Clowder AI; its existing behavior and ownership boundaries are constraints, not implementation suggestions.
- Reuse existing upstream memory, context compression/session lifecycle, routing, A2A/handoff, tasks, queues, scheduling, permissions, model/runtime configuration and persistence without changing their mechanisms. Bot may expose supported upstream APIs, events and configuration through protocol adapters and UI, preserving their semantics, authorization and source of truth.
- Higher-level adaptation and composition are allowed. Bot is not limited to a one-to-one copy of upstream screens or endpoints: it may combine supported native operations into a simpler user action, supply valid defaults, translate requests, and aggregate native records into a coherent chat experience. Evaluate this path before declaring that a product need requires an upstream change. Preserve each operation's authorization, lifecycle, data ownership and failure semantics; request acceptance must not be presented as completion, and a partly successful sequence must not be presented as an atomic success.
- A change to an upstream mechanism must be implemented in Clowder AI first. Adopt it only after it is available in an upstream revision, by upgrading the pinned dependency and verifying integration. Record missing capabilities as upstream requirements; do not implement a replacement or parallel runtime subsystem in Bot.
- External patches, changes in generated runtime builds, monkey patches, hooks, injected policy prompts and duplicate stores are not loopholes for modifying upstream behavior. Keeping the source submodule pristine alone does not establish compliance. Using an existing supported role/configuration setting as designed is allowed; changing the execution policy behind it is not.
- Bot-owned work is presentation and integration: the existing XBot/café UI, navigation, display metadata and native references, protocol conversion, higher-level interaction flows over supported native operations, supported native configuration, and deployment/integration verification. UI flow state and request bookkeeping are allowed; they must not become a second scheduler, memory engine, runtime lifecycle state machine, or authoritative domain store.
- Before proposing or implementing a feature, identify its capability in the pinned, unpatched upstream source and the actual API/event/configuration contract; explain any higher-level composition and its partial-failure behavior. Distinguish upstream-native capability, Bot presentation/adapter work, existing local patches and upstream-dependent requests. A feature implemented by a local patch is not an upstream-native capability merely because it runs inside Clowder AI.
- Existing runtime patches are historical compatibility debt, not precedents or authorization for further divergence. Audit their behavior and upstream replacement path; do not add or expand them. Retire them through an explicit, verified migration to upstream capability. This policy change does not itself authorize abruptly removing existing functionality or deleting/migrating user data.
- Competitor research may inform presentation and upstream proposals. It does not authorize porting another product's memory, orchestration, context-management or permission mechanisms into Bot.
- When investigating local Agent discovery or onboarding, consult OpenBot if a comparison would clarify the user flow. Verify the actual runtime and model contracts against pinned Clowder AI and the installed local tool.

## Chat-first usability

- The default experience is a simple chat application, following the user's stated direction of Dots and Grok Bot. Users should be able to choose a cat or group, say what they need, attach material, and receive results without learning Agent concepts.
- Everyday use must not require understanding or managing models/providers, reasoning effort, context windows, compression, internal sessions, workspaces, task trees or routing. Use existing native defaults and lifecycle behavior behind the adapter. Necessary setup should be guided and minimal; detailed configuration and diagnostics belong in optional advanced/settings views.
- Native concepts and APIs are implementation details, not a required navigation structure. Do not mirror the engine's object model in the primary UI or require users to create a project, select a workspace, or create/assign a Task before ordinary conversation and work.
- Keep the primary layout and interactions focused on chats, cats/groups, messages, attachments and results. Prefer existing chat interactions and progressive disclosure; every new top-level page, persistent panel, field or confirmation needs a concrete user need. Do not add placeholders for capabilities that are not usable.
- Use concise, everyday, task-oriented language. Show who is working, what needs the user's attention and the actual result; reveal technical identifiers, logs, token statistics and execution details only when requested or needed for diagnosis. Avoid turning empty states and routine screens into architecture tutorials.
- Simplicity must preserve truth and meaningful control. Do not conceal failures, partial results, permission requests or material consequences. Do not label a request as applied or a task as completed without native evidence; give the user a clear next action and optional details.
- Review each proposed feature against both gates: can it be implemented through supported upstream capability or higher-level adaptation without changing the engine, and can a user complete it without learning how Agents work? Record the actual upstream dependency if the first gate fails; simplify the product flow if the second fails.

## Frontend ownership

- The user requires all frontend design and development work to be delegated to the locally installed Claude Code, using `claude-opus-5-5` with `--effort max` or `--effort xhigh`. Verify the requested model is available; do not silently substitute another model or an agent hosted elsewhere.
- Do not use the `frontend-design` / `frontend design` skill. Do not instruct the delegated agent to use it.
- The primary agent can define backend contracts, inspect/review changes and perform integration verification. Frontend implementation and any frontend fixes must be made by the delegated local Claude Code agent.
- Incremental frontend changes must preserve the existing XBot layout, interaction conventions, typography and tokens, including the current Clowder café theme. Inspect repository frontend documentation and source conventions before extending them. Do not invent an upstream style guide if none has been found.
- Preserve original frontend source hashes and attribution. Record reviewed changes and new extensions in the frontend manifest; never weaken verification just to pass a check.

## Runtime ownership

- Clowder AI is the sole execution authority. Keep its submodule pristine and follow the upstream-first boundary above; recording a change as an external patch does not make it permitted.
- Bot product code binds local Agent runtimes, rather than maintaining an independent model/provider catalog, credential store, orchestration or memory engine.
- Installed, configured and actively executing are different facts. Derive active state from native invocation records; never label a discovered executable as a running Agent session.
- Do not delete existing Redis, SQLite, transcripts or account data while changing UI or adapters.
