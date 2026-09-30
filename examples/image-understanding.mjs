import { JevBrowser } from '@tontoko/jev-browser';

// Opt-in: only use an approved test page whose screenshots may be sent to this endpoint.
// The decision engine uses the usual JEV_API_KEY / JEV_BASE_URL settings.
const { JEV_EXAMPLE_URL, JEV_VISION_BASE_URL, JEV_VISION_MODEL, JEV_VISION_API_KEY } = process.env;
if (!JEV_EXAMPLE_URL || !JEV_VISION_BASE_URL || !JEV_VISION_MODEL)
  throw new Error('Set JEV_EXAMPLE_URL, JEV_VISION_BASE_URL and JEV_VISION_MODEL explicitly.');
const browser = await JevBrowser.launch({
  vision: { baseURL: JEV_VISION_BASE_URL, model: JEV_VISION_MODEL, apiKey: JEV_VISION_API_KEY },
});
try {
  await browser.goto(JEV_EXAMPLE_URL);
  const result = await browser.screenDecide({
    state: { purpose: 'Inspect the currently visible page, without operating it.' },
    questions: {
      purpose: { type: 'choice', instructions: 'Does the captured view communicate its purpose?', criteria: {
        clear: 'A visible heading and content identify the purpose.',
        unclear: 'The purpose is unclear or the image lacks enough evidence.',
      } },
      consequence: { type: 'choice', instructions: 'Does visible copy state the consequence of the primary action?', criteria: {
        explained: 'The consequence is stated visibly.',
        unclear: 'The consequence cannot be established from visible text.',
      } },
    },
  }, { timeoutMs: 60_000 });
  // Do not treat a model opinion as a passing functional assertion or as proof that real users understand the UI.
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
