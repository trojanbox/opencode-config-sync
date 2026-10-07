# Development notes

- Target the OpenCode V2 plugin contract (`plugins` config, default export with stable `id` and `setup`).
- Keep the runtime dependency-free where possible so a local plugin can load even when plugin SDK resolution is broken.
- Treat the configured OpenCode directory and Git remote as user data. Never delete or overwrite a path outside the explicit sync allowlist.
- Reject symlinks in synchronized content by default to avoid reading outside the config directory.
- Never force-push. Remote races must fail and be retried after a fresh fetch/merge.
- Secret scanning must run before any commit that would publish local content.
- File conflicts are resolved at whole-file granularity. Do not silently choose a side unless the caller explicitly uses directional force.
- Keep unit tests runnable with Node 22 and local Git only; tests must not require network access.
