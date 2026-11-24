import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

export function loadPricing(file = process.env.PRICING_FILE || path.join(here, 'pricing.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return [...raw.models].sort((a, b) => b.match.length - a.match.length);
}

export function findPrice(pricing, model) {
  if (!model) return null;
  const id = model.toLowerCase();
  return pricing.find((p) => id.includes(p.match.toLowerCase())) || null;
}

/**
 * Cost in USD for one LLM response. `cache_write_tokens` is the total cache
 * write, of which `cache_write_1h_tokens` were the 1h tier; the rest are 5m.
 *
 * @returns {{ cost: number, priced: boolean }}
 */
export function computeCost(pricing, usage) {
  const price = findPrice(pricing, usage.model);
  if (!price) return { cost: 0, priced: false };

  const write1h = Math.min(usage.cache_write_1h_tokens || 0, usage.cache_write_tokens || 0);
  const write5m = (usage.cache_write_tokens || 0) - write1h;
  const perToken = (rate) => rate / 1_000_000;

  const cost =
    (usage.input_tokens || 0) * perToken(price.input) +
    (usage.output_tokens || 0) * perToken(price.output) +
    (usage.cache_read_tokens || 0) * perToken(price.cache_read ?? price.input * CACHE_READ_MULT) +
    write5m * perToken(price.cache_write_5m ?? price.input * CACHE_WRITE_5M_MULT) +
    write1h * perToken(price.cache_write_1h ?? price.input * CACHE_WRITE_1H_MULT);

  return { cost, priced: true };
}
