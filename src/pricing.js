'use strict';

// Standard text-token API rates per million, checked 2026-10-15.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// These are an API-equivalent estimate, never a ChatGPT subscription charge.
const rates = {
  'gpt-6.1-sol': [2, .1, 10], 'gpt-6-astra': [10, 1, 50],
  'gpt-6-sol': [2, .2, 10], 'gpt-6-luna': [.1, .01, .5],
};
function codexEstimate(model, usage, { longContext = false } = {}) {
  const rate = rates[model];
  if (!rate || !usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  const input = Math.max(0, usage.input_tokens), output = Math.max(0, usage.output_tokens);
  const cached = Math.min(input, Math.max(0, usage.cached_input_tokens || 0));
  return ((input - cached) * rate[0] * (longContext ? 2 : 1) + cached * rate[1] * (longContext ? 2 : 1) +
    output * rate[2] * (longContext ? 1.5 : 1)) / 1e6;
}

module.exports = { codexEstimate };
