# Capabilities

Tauri denies the frontend every native API unless a capability grants it, so
this directory is the complete list of what the webview can reach.

`default.json` grants exactly two things:

- **`store:*`** -- the session token is written to the OS application-data
  directory instead of `localStorage`. Scoped to the specific commands used
  (`load`, `get`, `set`, `delete`, `save`) rather than the plugin's own
  `default` set, which also exposes commands we do not call.
- **`opener:allow-open-url`** -- opens a link in the user's real browser. The
  frontend validates the scheme before calling (see `src/lib/platform.ts`), so
  only `http` and `https` ever reach it.

Deliberately **not** granted, and the reason each matters:

| Not granted                  | Why                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `fs:*`                       | The frontend never needs disk access. Granting it would make an XSS in the webview a read/write primitive on the user's files. |
| `shell:*`                    | Nothing needs to run a process. This is the single most dangerous permission to grant a web frontend.                          |
| `http:*`                     | The app uses the webview's own `fetch`, which the CSP governs. Tauri's HTTP client bypasses CSP entirely.                      |
| `dialog:*`, `notification:*` | Not used yet. Added only when a feature needs them.                                                                            |
| `assetProtocol`              | Disabled in `tauri.conf.json`. It would expose local files through a custom URL scheme.                                        |

When adding a native capability, grant the narrowest permission that works and
record why here.
