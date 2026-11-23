// The win model's arithmetic, mirroring lol_model_lib.predict, breakdown and lol_features_lib.matchup_features.
// Everything that needs history (ratings, mastery levels) is precomputed in site.json by lol_site.ipynb.

export const ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"];

const playerIndex = new WeakMap();
function players(data) {
  if (!playerIndex.has(data)) playerIndex.set(data, new Map(data.players.map((p) => [p.id, p])));
  return playerIndex.get(data);
}

// entries: 5 [role, playerId, champion]; mastery is NaN when no player on the side has career rows
export function sideValues(data, entries) {
  const byId = players(data);
  const ratings = [];
  const levels = [];
  for (const [, id, champion] of entries) {
    const p = byId.get(id);
    ratings.push(p ? p.rating : data.meta.unknown_rating);
    if (p && p.career) levels.push(p.mastery[champion] ?? 1);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { rating: mean(ratings), mastery: levels.length ? mean(levels) : NaN };
}

function columnValue(column, minute, row, champions) {
  if (champions.has(column)) return row.blueChampions.has(column) ? 1 : row.redChampions.has(column) ? -1 : 0;
  switch (column) {
    case "team_1_blue": return 1;
    case "rating_diff": return row.rating_diff;
    case "mastery_diff": return row.mastery_diff;
    case "minute_x_rating_diff": return (minute / 10) * row.rating_diff;
    case "minute_x_mastery_diff": return (minute / 10) * row.mastery_diff;
    default:
      if (column.startsWith("minute_")) return minute === Number(column.slice(7)) ? 1 : 0;
      return 0;
  }
}

function logit(p) {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  return Math.log(q / (1 - q));
}

function score(data, row, minute) {
  const { model } = data;
  const champions = new Set(model.champions);
  const [columns, weights] = minute === 0 ? [model.columns_0, model.weights_0] : [model.columns, model.weights];
  let total = 0;
  for (let i = 0; i < columns.length; i++) total += columnValue(columns[i], minute, row, champions) * weights[i];
  let p = 1 / (1 + Math.exp(-total));
  if (model.stretch) {
    const factor = minute === 0 ? model.stretch.stretch_0 : model.stretch.stretch_later;
    p = 1 / (1 + Math.exp(-factor * logit(p)));
  }
  return p;
}

// P(blue wins | still going at each landmark) and the feature row it came from
export function predictCurve(data, blue, red) {
  const b = sideValues(data, blue);
  const r = sideValues(data, red);
  const masteryDiff = b.mastery - r.mastery;
  const row = {
    rating_diff: b.rating - r.rating,
    mastery_diff: Number.isNaN(masteryDiff) ? 0 : masteryDiff,
    blueChampions: new Set(blue.map((e) => e[2])),
    redChampions: new Set(red.map((e) => e[2])),
  };
  const curve = {};
  for (const minute of data.meta.landmarks) curve[String(minute)] = score(data, row, minute);
  return { curve, row };
}

const GROUPS = { team_1_blue: "side", rating_diff: "ratings", mastery_diff: "mastery" };

// pre-game log-odds per group, and the same split in percentage points (null near a coin flip)
export function breakdown(data, row, p0) {
  const { model } = data;
  const champions = new Set(model.champions);
  const parts = { ratings: 0, champions: 0, mastery: 0, side: 0 };
  model.columns_0.forEach((column, i) => {
    const group = GROUPS[column] ?? (champions.has(column) ? "champions" : null);
    if (group) parts[group] += columnValue(column, 0, row, champions) * model.weights_0[i];
  });
  const total = parts.ratings + parts.champions + parts.mastery + parts.side;
  const points = Math.abs(p0 - 0.5) < 0.005 ? null
    : Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, 100 * (p0 - 0.5) * (v / total)]));
  return { ...parts, points };
}

// The breakdown's points rounded to `digits` decimals so the shown parts add up exactly to the shown total
// (the sum of the exact points, rounded the same way). points: { ratings, champions, mastery, side } -> same keys.
// Largest remainder: round every part down in whole steps, then give the missing steps to the largest leftovers.
export function roundPoints(points, digits) {
  const scale = 10 ** digits;
  const scaled = Object.entries(points).map(([key, v]) => [key, v * scale, Math.floor(v * scale)]);
  // the total exactly as the page shows it (sum, then toFixed), so a tie like -1.75 rounds the same way in both
  const target = Math.round(Number(Object.values(points).reduce((s, v) => s + v, 0).toFixed(digits)) * scale);
  let missing = Math.round(target - scaled.reduce((s, [, , down]) => s + down, 0));
  const out = Object.fromEntries(scaled.map(([key, , down]) => [key, down]));
  for (const [key] of [...scaled].sort((a, b) => (b[1] - b[2]) - (a[1] - a[2]))) if (missing-- > 0) out[key] += 1;
  return Object.fromEntries(Object.entries(out).map(([key, steps]) => [key, steps / scale]));
}

// u.gg lane counters for each lane where either champion's page has the matchup; a is blue's champion
export function counters(data, blue, red) {
  const rows = [];
  ROLES.forEach((role, i) => {
    const a = blue.find((e) => e[0] === role)?.[2];
    const b = red.find((e) => e[0] === role)?.[2];
    const direct = data.counters[`${role}|${a}|${b}`];
    const reverse = data.counters[`${role}|${b}|${a}`];
    // entries: [win rate, matches, edge in win-rate points beyond both champions' strength, consistent, patches]
    if (direct) rows.push({ role, a, b, winRate: direct[0], matches: direct[1], edge: direct[2], consistent: direct[3], patches: direct[4] });
    else if (reverse) rows.push({ role, a, b, winRate: 1 - reverse[0], matches: reverse[1], edge: -reverse[2], consistent: reverse[3], patches: reverse[4] });
  });
  return rows;
}

export function flags(data, blue, red) {
  const byId = players(data);
  const champions = new Set(data.model.champions);
  const out = [];
  for (const [, id, champion] of [...blue, ...red]) {
    const p = byId.get(id);
    if (p && p.months_since !== null && p.months_since > data.meta.stale_months)
      out.push(`stale: ${p.name} (last pro game over ${Math.floor(p.months_since)} months ago)`);
    if (!champions.has(champion)) out.push(`new champion: ${champion} (no pro data)`);
  }
  return out;
}

// Every number behind the pre-game prediction, for the "Show the math" section.
export function mathSteps(data, blue, red) {
  const { model } = data;
  const weight = Object.fromEntries(model.columns_0.map((column, i) => [column, model.weights_0[i]]));
  const b = sideValues(data, blue);
  const r = sideValues(data, red);
  const { curve, row } = predictCurve(data, blue, red);
  const ratings = { blue: b.rating, red: r.rating, diff: row.rating_diff, weight: weight.rating_diff };
  ratings.contribution = ratings.diff * ratings.weight;
  const mastery = { blue: b.mastery, red: r.mastery, diff: row.mastery_diff, weight: weight.mastery_diff,
    fallback: Number.isNaN(b.mastery - r.mastery) };
  mastery.contribution = mastery.diff * mastery.weight;
  const champions = [...blue.map((e) => [e[2], "blue", 1]), ...red.map((e) => [e[2], "red", -1])]
    .map(([name, side, sign]) => ({ name, side, weight: weight[name] ?? 0, contribution: sign * (weight[name] ?? 0) }));
  const side = { weight: weight.team_1_blue, contribution: weight.team_1_blue };
  const total = ratings.contribution + mastery.contribution + side.contribution
    + champions.reduce((s, x) => s + x.contribution, 0);
  const p = curve["0"];
  // raw: the chance before recalibration; stretch: the factor on the log-odds, null when the model has none
  return { ratings, mastery, champions, side, total, raw: 1 / (1 + Math.exp(-total)), stretch: model.stretch?.stretch_0 ?? null,
    p, points: breakdown(data, row, p).points };
}

// y-axis range for the curve: the data's range padded by max(2 points, 25% of the range), shifted (not cut) to stay
// inside 0-100%, then snapped outward to a tick step of 1, 2, 5, 10 or 20 points (the first giving at most 6 ticks)
export function curveScale(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(0.02, 0.25 * (max - min));
  let [lo0, hi0] = [min - pad, max + pad];
  if (lo0 < 0) [lo0, hi0] = [0, Math.min(1, hi0 - lo0)];
  if (hi0 > 1) [lo0, hi0] = [Math.max(0, lo0 - (hi0 - 1)), 1];
  const round = (x) => Math.round(x * 1e6) / 1e6;
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.2]) {
    const lo = Math.max(0, round(Math.floor(round(lo0 / step)) * step));
    const hi = Math.min(1, round(Math.ceil(round(hi0 / step)) * step));
    const n = Math.round((hi - lo) / step) + 1;
    if (n <= 6 || step === 0.2) return { lo, hi, ticks: Array.from({ length: n }, (_, i) => round(lo + i * step)) };
  }
}

// the sign a number shows at this many decimals: 0 when it rounds to zero, so a tiny negative is not shown as "-0.0"
export function shownSign(x, digits) {
  return Math.sign(Number(x.toFixed(digits))) || 0;
}
