# Local API contract

This is the retained `/api` backend contract. The current original XBot frontend uses `/xbot-api`; see [xbot-api.md](xbot-api.md). Avatar fields below are legacy identity metadata; the current UI uses XBot's original generated portrait library and its own avatar-seed endpoints.

All JSON; errors `{error:string}` with appropriate HTTP status. API binds loopback. SSE `/api/events`: named `state` carries complete AppState (initially and on changes), named `delta` carries DeltaEvent. GET `/api/state` same snapshot. Client reloads snapshot on SSE reconnect.

- POST `/api/bots` `{templateId,name?,description?,persona?,provider?,model?}` → Bot (201), also create direct conversation.
- PATCH `/api/bots/:id` `{name?,description?,persona?,provider?,model?}` → Bot.
- POST `/api/conversations` `{title?,kind:'direct'|'group',botIds:string[]}` → Conversation (201).
- PATCH `/api/conversations/:id` `{title?,pinned?,botIds?}` → Conversation.
- DELETE `/api/conversations/:id` → `{ok:true}` (cancel first).
- POST `/api/conversations/:id/messages` `{content:string,botId?:string}` → `{runId:string}` (202). Reject concurrent run with 409. Without explicit bot: mention routing, otherwise lead member. Group can handoff via line-leading `@name task`; roster is supplied to agents.
- POST `/api/conversations/:id/cancel` → `{ok:true}`.
- POST `/api/conversations/:id/compact` → Conversation; preserve original messages, advance summary boundary.
- POST `/api/memories` `{scope,botId?,conversationId?,content,tags?}` → Memory (201).
- DELETE `/api/memories/:id` → `{ok:true}`.
- PUT `/api/settings` partial Settings → Settings. API keys stay in environment, never persisted or returned.
- GET `/api/health` → `{ok:true,mode:string}`.

Seed 3 bots from ragdoll, maine-coon, siamese; one welcoming group “猫猫协作室”, direct conversations for each. No fabricated past user messages. Initial notice/welcome may explain demo mode. Avatar paths `/avatars/{templateId}.svg`; user `/avatars/user.svg`.

Provider module `server/providers/index.ts` exports `getProvider(kind:ProviderKind):AgentProvider`. Server selects demo if settings.mode=demo; otherwise bot.provider; reject demo in live if bot not configured. Demo module can be defined by backend owner (coordinate). Providers may emit session id; context compaction invalidates saved session. Plain text control protocol for all providers: standalone line `@<bot name or id> <task>` for handoff; optional `<memory scope="shared|bot">content</memory>` for explicit agent memory. The orchestrator validates targets, scopes, hops and strips control tags from display. Agent text is untrusted; no generic shell tool is exposed by our HTTP API.
