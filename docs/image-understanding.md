# Optional image understanding

`screenDecide` (CLI `screen_decide`, MCP `browser_screen_decide`) is an opt-in way for a
text-only caller or decision model to use what is visible on the screen:
**one viewport capture → a configured image endpoint describes it → the existing Jev
decision engine answers your questions from that description**. It sends no input and
chooses no coordinates. Normal DOM/ARIA operations and `screen` never call it and add no
image request. When your agent can read images itself, plain `screen` is simpler and
faster: it returns the images directly.

The image endpoint receives only the PNG frames, capture times and pixel size. It does not
receive your questions, `state`, DOM/ARIA, the URL, the title or local file paths. The
decision endpoint receives your questions, your `state` and the description as text, never
image bytes. All questions in one call share one description.

## CLI and MCP

```sh
export JEV_VISION_API_KEY=...   # only if the image endpoint needs a key
npx jev-browser open https://example.com --session visual --screen-only \
  --vision-base-url https://vision.example/v1 --vision-model your-image-model
npx jev-browser screen_decide --session visual --args '{
  "state": {"goal": "Save the form"},
  "questions": {"control": {"instructions": "Which visible control saves the form?",
    "criteria": {"save": "A control visibly labelled Save", "unknown": "Not identifiable from the image"}}}
}'
```

`--vision-base-url` and `--vision-model` must be given together, and are fixed when a
session opens (reopening with different values fails with `SESSION_MODE_MISMATCH`). The MCP
server takes the same flags and lists `browser_screen_decide` only when they are set. The
command also works in `--screen-only` sessions, since it reads only pixels. Without the
flags it fails with `CONFIG`.

Each question has `instructions` and at least two `criteria` (choice id → meaning). The
result is:

- `decision`: Jev's `answers` (`choice`, `confidence`), `model` and `usage`, unchanged.
- `evidence`: `observationId`, `viewport`, `coordinateSpace: 'image-pixels'`,
  `freshness: 'snapshot'`, `frames` (`sha256`, `capturedAt`, and `path` when `--output-dir`
  saved the originals), `interpretation` (the description), the image `model` and
  `requestedModel`, image `usage` when reported, and `elapsedMs`.

`evidence.observationId` is the current screen observation, so you can act on it with
`screen` `click`/`type`/... as with a `look`. Pass `capture` (`frames`, `intervalMs`) for a
short frame sequence and `timeoutMs` for a larger budget; the capture, the image request and
the decision share it.

## SDK

```js
import { JevBrowser } from '@tontoko/jev-browser';

const browser = await JevBrowser.launch({
  vision: { baseURL: 'http://localhost:8000/v1', model: 'your-image-model' /*, apiKey */ },
});
await browser.goto('https://example.com');
const { decision, evidence } = await browser.screenDecide({
  state: { goal: 'Save the form' },
  questions: { control: { type: 'choice', instructions: 'Which visible control saves the form?',
    criteria: { save: 'A control visibly labelled Save', unknown: 'Not identifiable from the image' } } },
}, { timeoutMs: 60_000 });
```

`vision` also accepts your own `ImageUnderstanding` object with
`describe(observation, { signal })` returning `{ text, model?, requestedModel?, usage? }`,
for another image protocol or an in-process model. It must honor cancellation.

For a capture you already have, `decideFromScreen(screen, request, { understand, engine, signal })`
does the same without touching the browser, using a `ChatCompletionsImageUnderstanding` or
your adapter and any `DecisionEngine`.

## Endpoint and credentials

`baseURL` is an OpenAI-compatible Chat Completions API root, including any version path.
The adapter posts one request to `baseURL + /chat/completions` with the images as ordered
`image_url` data URLs and `stream: false`. The model must accept PNG input. There is no
default provider or model, no retry and no redirect following.

- The endpoint must be HTTPS, or HTTP to a loopback host (`localhost`, `127.0.0.0/8`,
  `[::1]`), even without a key; anything else fails with `CONFIG`.
- It is authenticated only by an explicit `apiKey` (CLI/MCP: `JEV_VISION_API_KEY`). Jev keys
  (`JEV_API_KEY`, `TYPESAFE_API_KEY`, `JEV_ENDPOINT_API_KEY`) and other provider variables are
  never sent to it, and the vision key is never sent to the decision endpoint.
- A failed, empty or cancelled description stops before any decision request. There is no
  fallback to DOM observation and no image forwarding to Jev.

## Limits

Descriptions can omit, misread or invent details, and can follow instructions shown in the
image despite the prompt. A caption that cannot locate a control is not permission to guess
coordinates or to fall back to DOM information. No description, decision or confidence is a
verified save, a functional pass or a usability verdict; keep deterministic assertions for
those, and include an insufficient-evidence choice in your questions. A result describes the
moment of capture; after the page changes, call it again. Two model calls are not assumed to
be faster or cheaper than one image-capable model: measure with your providers.
