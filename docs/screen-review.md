# Screen-only browser review

Screen mode lets an outer vision-capable reviewer use the application through viewport images and physical inputs. It supplies no DOM text, accessibility labels, selectors, generated instructions, URL/title metadata or UX verdict. Ordinary Jev-powered automation remains available in normal sessions.

## Trusted setup

The initial URL, authentication, browser context and artifact directory belong to trusted test setup:

~~~sh
jev-browser open https://example.com --session visual --screen-only
jev-browser screen --session visual --args '{"action":"look"}'
jev-browser close --session visual
~~~

For MCP, run jev-browser-mcp with --screen-only and --url. Discovery starts no browser and exposes only browser_screen and browser_close. Its first screen request starts the configured browser and performs the trusted initial navigation. Results carry actual MCP image blocks and separate metadata without base64 or local paths.

Named sessions keep their mode for their lifetime. Reopening a normal session with --screen-only, or reopening a restricted session without that mode, fails before navigation. Restricted sessions cannot be reopened at another supplied URL. Individual commands cannot turn their mode off.

~~~ts
const browser = await JevBrowser.launch({
  screenOnly: true,
  contextOptions: { viewport: { width: 390, height: 844 } },
  outputDir: './review-evidence',
});
await browser.page.goto(startURL); // trusted setup, before the reviewer

let seen = await browser.screen({ action: 'look' });
seen = await browser.screen({
  action: 'click', x: 120, y: 160, observationId: seen.observationId,
});
seen = await browser.screen({
  action: 'type', text: 'A supplied example', observationId: seen.observationId,
});
~~~

The optional allowCommand callback also receives {command:'screen', request} and must return literal true. Existing allowlists that do not permit screen operations continue to deny them. Scope, selectors and arbitrary JavaScript are not screen arguments.

## Images and physical inputs

SDK browser.screen(request), CLI screen --args JSON, and MCP browser_screen share the same strict action union. The MCP tool advertises one flat object for hosts that reject top-level unions; its field descriptions state which actions need each field. An invalid request returns `INVALID_ARGUMENT` naming the action and each failing field in the message and in `details.issues`. When the shared core rejects it, `details.observationId` also carries the current observation ID.

| Action | Additional arguments |
| --- | --- |
| look | None |
| click, move | observationId, x, y |
| drag | observationId, x, y, toX, toY |
| scroll | observationId, deltaX and/or deltaY (an omitted delta is 0), optional paired x/y |
| type | observationId, text; types into current focus |
| press | observationId, key from the published editing/navigation enum |
| back, forward, reload | observationId, except while no current observation exists (recovery) |
| wait | milliseconds from 0 to 10,000; optional observationId |

Coordinates refer to pixels in the returned viewport image, including mobile screenshots. The core privately reads numeric viewport geometry to map Chromium image coordinates to native pointer input when the page is scaled. Ordinary desktop and mobile meta-viewport pages remain 1:1. Wheel deltas retain native wheel units; only an optional wheel position uses image coordinates. Out-of-image inputs are rejected. The tool does not locate elements, scroll them into view, fill unobserved fields, capture full pages or expose page evaluation. Keyboard chords for clipboard access, address-bar focus, source and developer tools are excluded. Ordinary editing, selection, undo and keyboard navigation remain available.

Pointer input with a nonzero visual viewport offset, or a non-unit scale on an engine other than Chromium, returns `SCREEN_VIEWPORT_UNSUPPORTED` before input. Images remain available for observation. These are explicit coordinate-mapping limits, not product UX findings.

Every successful action returns fresh viewport images. There is no fixed settle delay, screenshot cache or action replay. When an input starts a main-frame navigation, or a look finds one in progress, capture first waits up to 5 seconds of the operation budget for that navigation to commit or end and for DOMContentLoaded. Optional capture settings {frames:1..10, intervalMs:20..1000} add timestamped images for transient states. Screenshots preserve CSS animations and caret rendering.

Results contain observationId, viewport, navigated, frames and an action record. navigated is true when the main frame navigated during the operation; the frames then show the page after that navigation. Frames carry PNG data, mimeType, capturedAt, elapsedMs and optionally a trusted artifact path. The action records id, kind, startedAt, durationMs and outcome. Total tool duration includes dispatch, browser work, capture and requested sampling delays. It is not application response time or a human task-time estimate. Actual timestamps are the evidence; requested intervals do not promise a recording frame rate.

For continuous motion, trusted setup can use Playwright recordVideo in contextOptions. Keep trace and DOM diagnostics with the separate functional verifier; do not give those artifacts to a reviewer evaluating visible discoverability.

## Freshness and failures

Inputs need the most recent successful observationId. Each capture or input attempt consumes it. Requests rejected before any capture or input keep it usable: invalid arguments, a policy denial, an old ID, out-of-image coordinates, an unsupported viewport transform and a screen-only command denial. IDs bind the selected Page, its main-frame navigation generation and the private viewport geometry read immediately after the last image. Old IDs, a main-frame navigation (including a same-document history change), a different selected Page or changed viewport dimensions, scale, offsets or scroll position require a new look. A child frame navigating is treated like other in-page content changes and does not invalidate the observation. Authorization waits are followed by the same checks. Geometry is not returned as actor metadata, and frame sequences may observe changing scroll positions.

A main-frame navigation during capture interrupts it. The capture, never the input, is then taken again once after the navigation settles, and the result reports navigated. A second navigation during that capture returns `STALE_SCREEN`. A returned observation always belongs to the current main-frame document.

This does not make browser input atomic with page changes. Content can move, animate or update after capture without navigating. Pixel-identical frames are deliberately not required: that would make animations and caret blinking unusable. Review the returned image before the next decision.

Failed inputs are never automatically retried. The result can be unknown because the browser already received an input. Look again before deciding what to do next. `SCREEN_FAILED` and `SCREEN_INTERRUPTED` carry `details.reason`: `timeout`, `cancelled`, `navigation`, `page-closed`, `dialog` or `unknown`. The reason never contains page content. SDK callers can inspect the underlying error as `cause`.

A failed capture leaves no current observation. If looking keeps failing, back, forward and reload may omit observationId while no current observation exists. They recover through browser history and return a fresh observation. Whenever a current observation exists, they still require its ID. Pointer and keyboard inputs always require the current ID.

Browser-native dialogs, file choosers and new tabs are explicit capability limits; report them as tool limitations, not proof that product UX failed. This version does not provide screenshot-based native-dialog/file-chooser handling or tab switching. A file chooser is reported once with `SCREEN_FILE_CHOOSER_UNSUPPORTED`; no file is selected and later observations continue on the same page. Restart a restricted session after a native dialog or a new tab that stays open.

A native dialog that opens asynchronously during capture can first interrupt that capture, reported with reason `dialog`, and leave a pending-dialog error on the next observation. Its contents are not a viewport image. Preserve the interrupted attempt and report the capture limitation instead of inferring an application result.

With a trusted outputDir, the session writes PNG frames and one JSONL record of permitted, denied and failed operations that reach the shared core. Records include coordinates, text length, timings, outcomes and image references with each frame's sha256 and pixel dimensions, without duplicating typed strings or DOM metadata. The first row keeps the same shape with action kind `header` and adds `header`: the jev-browser, Playwright and browser versions, the configured viewport and any supplied launch options. Plain display settings such as viewport, locale and headless are kept; credentials, HTTP headers, storage state, file paths, endpoints, environment and other values are recorded only as `[redacted]`. Images can naturally contain visible input. Protocol/schema rejections before the core belong to the calling agent's tool transcript. This journal is ordinary local evidence, not a tamper-proof audit or proof that a crashed process persisted its last operation.

## Trust and judgment

screenOnly restricts shared command dispatch, CLI sessions and MCP exposure. Trusted SDK code retains the real Playwright browser.page. Another local process, unrestricted shell, ordinary MCP server or filesystem access can exceed this surface. Give the reviewer only screen tools and intended public task context; keep source code, correct routes and authentication setup outside that context.

The reviewer can examine discoverability, wording, hierarchy, feedback, recovery and motion. Successful inputs alone do not establish durable business data, accessibility conformance, real-user success rates or good UX. Keep deterministic application assertions with the functional verifier and require visible evidence for review findings.
