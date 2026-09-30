# Migrating browser automation

Jev Browser is a functional alternative, not a drop-in alias for another package's JavaScript types, CLI flags or MCP schemas. The shared core is intentionally explicit about grounded data, ownership, authorization and verified completion.

## Playwright MCP

Change the MCP executable to `jev-browser-mcp` or the installed `dist/mcp-stdio.js`. Standard operation names are exposed as `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_tabs`, `browser_handle_dialog`, `browser_file_upload`, `browser_take_screenshot`, and other documented native tools. Discovery uses the official MCP protocol and is tested with the official client.

Take a new snapshot and use **this server's refs**, not refs from an old Playwright MCP connection. Native methods accept the human-readable `element` field, but actual targeting uses `ref` or `target`. `target` is a Playwright selector supplied by a trusted caller. Snapshot results are structured JSON rather than Microsoft's exact text format.

Use `browser_act` for natural-language action selection and `browser_assert` for deterministic verification. Tool cancellation propagates to the shared core. A pending dialog is explicit and can be handled in the next call.

Playwright MCP's `--viewport-size` and `--config` correspond to `--viewport WxH` and `--options-file FILE`. The file holds the launch fields of `JevBrowser.launch()` options (`launchOptions`, `contextOptions`, `storageState` and so on), not Playwright MCP's configuration format.

Page-side `browser_evaluate` is available only with `--allow-evaluate`, and currently accepts a page function rather than a target-bound function. Arbitrary Node-side `browser_run_code` is deliberately not provided; write that orchestration in the SDK using `browser.page`. Browser extensions and proprietary service integration are not included; use CDP or a Playwright WebSocket endpoint when attaching to another browser.

## Playwright CLI

| Workflow | Jev Browser |
| --- | --- |
| Open a retained browser | `open URL --session work` |
| Emulate a viewport or device | `open URL --session work --viewport 390x844`, or `--options-file FILE` for other context options |
| Read the page | `snapshot --session work` |
| Click/type by ref | `click REF`, `fill REF TEXT`, with `--session work` |
| Select/check/keyboard | `select REF VALUE`, `check REF`, `uncheck REF`, `press Enter` |
| Native arbitrary arguments | `COMMAND --args JSON` or `call COMMAND --args JSON` |
| Bounded natural-language workflow | `run INSTRUCTION --values JSON --max-steps N` |
| Verify outcome | `assert --args JSON`; failure exits nonzero |
| Retain state over a pipe | `session` with JSONL commands and optional request IDs |
| Inspect/close sessions | `sessions`, `close --session work` |

CLI output is always JSON (apart from help/version). Screenshots return image data and optionally save an artifact; use `take_screenshot --args '{"filename":"page.png"}'` to choose a file. Outputs stay inside the artifact directory. Flags and storage paths are not compatible with an existing Microsoft session descriptor. Retake snapshots during migration and close old sessions explicitly.

## Stagehand

```ts
const browser = new JevBrowser({ page });
await browser.act('Fill email with email', { values: { email: 'user@example.invalid' } });
const plan = await browser.observe('Click Save');
if (plan) await browser.act(plan);
const { data, evidence } = await browser.extract('Read rows', schema, { recordsScope: 'tbody tr' });
const result = await browser.agent({ maxSteps: 8, until: verify }).execute({ instruction: goal, values });
```

Use the existing Playwright Page/fixtures and keep ordinary `expect` assertions. A browser constructed with a Page does not own it. Natural-language input variables use `values`, not upstream `%variable%` templating. Explicit values stay local, while literal quoted text is already visible in the prompt.

`observe` returns a single plan or null, rather than an array of reusable actions. Plans are single-use. `extract` returns `data` together with evidence, snapshot and decision metadata. Its contract is copying observed facts, not generating summaries. Nested objects, scalar roots and arrays of actual DOM rows/cards are available; record scopes preserve cross-field coherence within each row.

The goal runtime batches independent field questions and record extraction, executes browser writes serially, handles native-form transitions and ordinary confirmations, and checks fresh result records. A model's completion opinion still stays unverified. `expect` works in SDK/CLI/MCP; `until` is an additional SDK callback. See [goal execution](goal-runtime.md) for default budgets and boundaries. Browserbase infrastructure, Stagehand's cache/replay service, cloud billing and arbitrary model-generated code are not included.

## Visual-only pages and large pages

For a vision-capable UX reviewer, create an isolated session with `--screen-only` and use the shared `screen` command. This opt-in surface gives images and physical inputs without accessible snapshots, selectors, semantic choices or route hints. See [screen review](screen-review.md). Existing SDK Page access is trusted setup/verification and is not an isolation boundary.

Screenshot and mouse-coordinate tools are available to an outer vision-capable agent. Jev itself is not an image model in this integration, so standalone autonomous Canvas/image interpretation is not claimed. Closed shadow roots are not inspectable by the DOM layer.

For large pages, explicit `scope` remains authoritative. Without one, a truncated page can be indexed into bounded real semantic regions (form/main/section/article/dialog/navigation) and Jev may select the region relevant to the current action/readback; ambiguous or still-truncated regions fail closed. `recordsScope` identifies repeated rows but is not a whole-page text filter. Very long native select lists are deferred rather than truncated, and standards-associated ARIA comboboxes use only their declared owned popup. The runtime never pretends an omitted candidate was observed.

## Upstream references

- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Microsoft Playwright CLI](https://github.com/microsoft/playwright-cli)
- [Stagehand act](https://docs.stagehand.dev/v4/basics/act)
- [Stagehand extract](https://docs.stagehand.dev/v4/basics/extract)

Compare against the versions you actually deploy; upstream interfaces change independently of this project.

## Upgrading to v0.7

`compareSemantic` remains a snapshot comparison. `assertSemantic` now re-reads the actual sources before returning and may fail inconclusive when the page changes while the model is running. Treat this as a stricter assertion, not a flaky outcome to retry blindly. Prefer known Playwright Locators for stable explicit target retrieval; otherwise keep the returned evidence and fresh/changed status in diagnostics.

SDK users can pass `{actual:{locator:page.getByTestId('plan')},expected:'Professional annual plan'}` or extend their existing Playwright `expect` with `semanticMatchers(core)` from `@tontoko/jev-browser/playwright`. No model key is required for an exact comparison. For CLI/MCP, the new `semantic_compare_batch`, `semantic_assert_batch` and `semantic_locate_batch` accept JSON descriptions/refs; Locator objects stay SDK-only.

Mixed model provenance is now reported in `models`; do not require a singular `model` when it is unknown or multiple models participated. Semantic failures now include `error.semantic` expected/results; treat logs as potentially sensitive UI data. Existing `run`, `resume`, native actions and deterministic assertions remain available without a new planner or backend service.

## Borrowed-page dialogs and tab-scoped events (next release)

A core attached to a borrowed Page no longer holds dialogs between its
operations. Playwright's default dismissal applies to the caller's own Page
actions, and Jev still returns a pending `dialog` for dialogs that open while
one of its operations runs. Pass `captureDialogs: true` to keep the previous
behavior. `JevBrowser.launch()`, the CLI and the MCP server are unchanged.

`console_messages`, `network_requests` and `downloads` `list` now report the
selected tab. Add `allTabs: true` where a multi-tab caller read every tab. Save
or cancel downloads by the new stable `id`; an `index` now addresses the
selected tab's list. `file_upload` without a target uses only a chooser opened
on the selected tab, and fails with `NO_FILE_CHOOSER` after that tab navigates.
Single-tab sessions see the same entries as before, with added `pageId` and
download `id` fields.

## Timeouts and error codes (next release)

An operation whose `timeoutMs` budget runs out now fails with `TIMEOUT`
instead of `CANCELLED`. `CANCELLED` remains for an aborted caller `signal` and
for `close()` during an operation. Code that treated `CANCELLED` as "timed out
or cancelled" should accept both codes.

`JevBrowser` operations now reject with `BrowserError` in place of raw
Playwright errors. Read `error.code` instead of matching Playwright error names
or messages, and use `error.cause` for the original error in local diagnostics.
Failures that CLI/MCP previously reported as `OPERATION_FAILED` or
`CANCELLED` may now carry `NAVIGATION_FAILED`, `INVALID_SELECTOR`,
`AMBIGUOUS_TARGET`, `BROWSER_LAUNCH_FAILED`, `TARGET_OBSCURED` or `TIMEOUT`.
A click blocked by a covering element is `TARGET_OBSCURED` rather than
`ACTION_INTERRUPTED` when Playwright shows it was never delivered.

CLI/MCP error JSON gains a `retryable` boolean; existing fields are unchanged.
`retryable` never authorizes repeating an action whose effect is unknown, and
Jev Browser still performs no automatic retries. TypeScript code that
constructs `BrowserError` now passes a `BrowserErrorCode`; cast a code that is
not in that union.

`close()` waits about one second for an in-flight operation, then closes owned
resources. It still never closes a borrowed Page, context or browser. See
[errors](api.md#errors-and-automation) for every new code.

## Removing the Pi adapter (next minor release)

The `@tontoko/jev-browser/pi` export, bundled Pi adapter and its dedicated launch
guide are removed. Use the existing SDK, persistent CLI or MCP interfaces;
Jev Browser does not own the agent host's model loop, context or lifecycle.
This is a breaking subpath removal, not a removal of screen control.

For screenshot-only operation, use the documented restricted MCP server
(`jev-browser-mcp --screen-only --url <ordinary-entry>`) or an explicitly
restricted CLI/SDK consumer. Keep authentication and launch configuration in
trusted setup. Configure the host to expose only the selected tools and task
context; adding an unrestricted shell is not an equivalent isolation boundary.
See [screen-only review](screen-review.md) for the shared commands and limits.

The old `JEV_SCREEN_URL` / `JEV_SCREEN_OPTIONS` adapter variables and Pi-specific
launch flags are not settings for the generic MCP server. Map only supported
options using the ordinary CLI/MCP documentation. The published v0.9.0 archive
and its historical verification remain unchanged.

## Hosted keys and custom endpoints (next release)

`JEV_API_KEY` and `TYPESAFE_API_KEY` are now sent only to hosted Jev
(`https://api.typesafe.ai`). Earlier releases also sent them to any custom
`baseURL` / `JEV_BASE_URL`, so a mistyped or untrusted endpoint received the
hosted key. A custom endpoint now receives a fixed placeholder unless you
authenticate it explicitly:

- SDK: pass `apiKey` together with `baseURL`.
- CLI and MCP: set `JEV_ENDPOINT_API_KEY`.

A proxy that forwards the hosted key needs it the same explicit way, for example
`JEV_ENDPOINT_API_KEY="$JEV_API_KEY"`. A key is sent only over HTTPS or to a
loopback host. A key for an `http://` endpoint on another host now fails with
`CONFIG` instead of travelling in clear text. Keyless custom endpoints,
including plain HTTP ones, work as before.

The upstream SDK's `TYPESAFE_BASE_URL` no longer redirects this library; use
`JEV_BASE_URL`. Empty key variables, such as `JEV_API_KEY=` from
`.env.example`, now count as unset.

## Observation scope and long text (next release)

An explicit `scope` that matches no element in any frame now fails with
`SCOPE_NOT_FOUND` in `snapshot`, `observe`, `act`, `extract` and the semantic
locate/compare/assert methods. Earlier releases returned an empty observation,
`null` or a no-match error. To check that a region is absent, use a native
`assert` with `count` or a Playwright Locator instead of an empty scoped
snapshot. `run` and `resume` are unchanged: a goal whose scope disappears after
navigation still stops or reports unverified readback.

Displayed text longer than 700 characters was silently omitted before. It is
now observed as its first 700 characters with `truncated: true` and counts
toward `maxTexts`, so a page with many long paragraphs can reach
`OBSERVATION_LIMIT` sooner; narrow `scope` or raise `maxTexts`. Read the full
text of a known element with a Playwright Locator (for example a semantic
`{locator, property: 'text'}` actual) rather than from a truncated source.

## Playwright and Zod peer dependencies (next release)

`playwright` and `zod` were bundled dependencies. They are now peer
dependencies: `playwright-core` `>=1.62.0 <2` and `zod` `^4.2.0`. The package
uses your project's copies, so a Page from your own Playwright or
`@playwright/test` and a Zod schema from your own `zod` are the same
implementation the SDK uses. Operation cancellation needs AbortSignal support,
which `playwright-core` added in 1.62; `z.fromJSONSchema` needs Zod 4.2.

- npm 7+ and pnpm install missing peers automatically, choosing the newest
  matching release. To share one `playwright-core` with an older
  `@playwright/test`, pin it to the same version
  (`npm install -D playwright-core@1.62.0` next to `@playwright/test@1.62.0`).
  `npm ls playwright-core zod` shows what is resolved.
- Yarn Berry does not install peers: run `yarn add -D playwright-core zod`
  next to the tarball.
- A project on `@playwright/test` older than 1.62 must upgrade it. An older
  resolved `playwright-core` makes `new JevBrowser()` and
  `JevBrowser.launch()` fail with `CONFIG`, naming the version found.
- `jev-browser install` now installs the browser build of the resolved
  (your) `playwright-core`, the same one `npx playwright install` installs.
- Import Playwright APIs in your own code from your own `playwright`,
  `playwright-core` or `@playwright/test`; this package never provided them.
