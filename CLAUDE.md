# Project collaboration rules

Read and follow [AGENTS.md](AGENTS.md) in full before planning, reviewing or changing this project. It is the canonical project policy, including frontend ownership, the XBot/café conventions, source attribution and runtime/data ownership.

Clowder Bot is built on Clowder AI. Reuse its existing mechanisms unchanged. Product work may adapt and present supported upstream APIs, events and configuration while preserving their semantics and authority. Changes to memory, context management, routing, tasks, handoff, scheduling, permissions or other runtime mechanisms must land in Clowder AI first and then be adopted through a verified pinned upgrade.

Higher-level adaptation is allowed: combine supported native operations, translate requests, supply valid defaults and aggregate native records to make the user's flow simpler. The UI need not mirror upstream screens or concepts. Preserve authorization, lifecycle, ownership and partial-failure semantics; UI/request bookkeeping must not become another runtime engine or authoritative domain store. Consider this path before marking a product need as blocked on upstream.

The default product experience is a simple chat application, following the user's Dots/Grok Bot direction: choose a cat or group, talk, attach material and receive results. Everyday use must not require knowledge of Agents, models, context windows, sessions or workspaces. Keep setup minimal and technical configuration/diagnostics optional; preserve the existing XBot/café conventions. Simplicity must retain truthful status, actionable errors and meaningful permission choices. Apply both the upstream-reuse and usability gates in AGENTS.md to every feature.

External patches and generated-build edits are not exceptions. Existing patches are historical debt to audit and retire through verified upstream adoption, not permission to extend them. Do not recreate missing runtime capabilities in the Bot layer. Before proposing a feature, distinguish unpatched upstream capability, presentation/adapter work, existing local patches and upstream-dependent requests.

Preserve existing user data and functionality while planning migration; do not remove runtime patches or migrate data merely because this policy was added.
