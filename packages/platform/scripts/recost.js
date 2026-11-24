// Recomputes cost_usd for every LLM span from the current pricing file.
// Run after editing pricing.json or adding prices for previously unpriced models:
//   npm run recost -w claude-monitor-platform
import { computeCost, loadPricing } from '../server/cost.js';
import { openDb } from '../server/db.js';

const db = openDb();
const pricing = loadPricing();
const select = db.prepare(
  `SELECT span_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens
   FROM spans WHERE op = 'llm' AND COALESCE(json_extract(attributes, '$.cost_source'), '') != 'reported'`,
);
const update = db.prepare('UPDATE spans SET cost_usd = ?, priced = ? WHERE span_id = ?');

let changed = 0;
db.transaction(() => {
  for (const row of select.iterate()) {
    const { cost, priced } = computeCost(pricing, row);
    update.run(cost, priced ? 1 : 0, row.span_id);
    changed += 1;
  }
})();

console.log(`recomputed ${changed} llm spans`);
db.close();
