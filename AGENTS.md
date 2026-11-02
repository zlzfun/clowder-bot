# Project collaboration constraints

## Frontend ownership

- The user requires all frontend design and development work to be delegated to the locally installed Claude Code, using `claude-opus-5-5` with `--effort max` or `--effort xhigh`. Verify the requested model is available; do not silently substitute another model or an agent hosted elsewhere.
- Do not use the `frontend-design` / `frontend design` skill. Do not instruct the delegated agent to use it.
- The primary agent can define backend contracts, inspect/review changes and perform integration verification. Frontend implementation and any frontend fixes must be made by the delegated local Claude Code agent.
- Incremental frontend changes must preserve the existing XBot layout, interaction conventions, typography and tokens, including the current Clowder café theme. Inspect repository frontend documentation and source conventions before extending them. Do not invent an upstream style guide if none has been found.
- Preserve original frontend source hashes and attribution. Record reviewed changes and new extensions in the frontend manifest; never weaken verification just to pass a check.

## Runtime ownership

- Clowder AI is the execution authority. Keep its submodule pristine and record necessary changes as external patches.
- Bot product code binds local Agent runtimes, rather than maintaining an independent model/provider catalog, credential store, orchestration or memory engine.
- Installed, configured and actively executing are different facts. Derive active state from native invocation records; never label a discovered executable as a running Agent session.
- Do not delete existing Redis, SQLite, transcripts or account data while changing UI or adapters.
