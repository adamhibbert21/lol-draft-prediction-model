// Page wiring: the map picker, the search popover and the prediction view. All maths lives in model.js.

import { ROLES, predictCurve, breakdown, counters, flags, mathSteps, curveScale, shownSign, roundPoints } from "./model.js";
import { SIDES, ROLE_LABELS, inactiveNote, emptyDraft, filledCount, isComplete, lineup, toHash, fromHash, searchChampions, searchPlayers } from "./draft.js";

const BADGES = { Top: "TOP", Jungle: "JNG", Mid: "MID", Bot: "ADC", Support: "SUP" };
// % of the minimap; red is blue mirrored across the top-left to bottom-right diagonal
const BLUE_POSITIONS = { Top: [12, 33], Jungle: [23, 52], Mid: [44, 57], Bot: [71, 88], Support: [55, 88] };
const position = (side, role) => (side === "blue" ? BLUE_POSITIONS[role] : [...BLUE_POSITIONS[role]].reverse());
const BREAKDOWN_LABELS = { ratings: "Player ratings", champions: "Champion strength", mastery: "Champion mastery", side: "Blue side" };

const PLAYER_SORTS = [["role", "Role"], ["team", "Team"], ["region", "League"]];

const app = document.getElementById("app");
let playerSort = "role";
let closeSearch = null;  // closes the open search popover, if any
let data;
let draft = emptyDraft();

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false)
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return el;
}

const champion = (name) => data.champions.find((c) => c.name === name);
const playerName = (id) => data.players.find((p) => p.id === id)?.name ?? id;
// the player's name plus a "!" marker when they have not played pro in over a year
const playerLabel = (id) => {
  const note = inactiveNote(data.players.find((p) => p.id === id));
  return [playerName(id), note ? h("span", { class: "inactive", title: note, "aria-label": note }, " !") : null];
};
const icon = (name) => {
  const c = champion(name);
  return c?.id ? `https://ddragon.leagueoflegends.com/cdn/${data.meta.ddragon_version}/img/champion/${c.id}.png` : "";
};
const percent = (p) => `${Math.round(100 * p)}%`;
// colour class and text for a signed number at this many decimals; one that rounds to zero is neutral and unsigned
const SIGN_CLASS = { 1: "blue", 0: "even", [-1]: "red" };
const signedText = (x, digits) => `${["-", "", "+"][shownSign(x, digits) + 1]}${Math.abs(x).toFixed(digits)}`;

function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  return { draft: fromHash(hash, data), view: /(^|;)v=result(;|$)/.test(hash) ? "result" : "pick" };
}

function setHash(view, push) {
  const hash = `#${toHash(draft)}${view === "result" ? ";v=result" : ""}`;
  if (push) location.hash = hash;
  else history.replaceState(null, "", hash);
}

function render() {
  closeSearch?.();  // a link or Back/Forward change must not leave a popover over the new page
  const parsed = parseHash();
  draft = parsed.draft;
  app.replaceChildren(parsed.view === "result" && isComplete(draft) ? resultView() : pickView());
}

// ── pick page ──────────────────────────────────────────────────────────────

function pickView() {
  const map = h("div", { class: "map", role: "group", "aria-label": "Summoner's Rift draft" });
  for (const side of SIDES) for (const role of ROLES) {
    const slot = draft[side][role];
    const [x, y] = position(side, role);
    const label = `${side} ${ROLE_LABELS[role]}`;
    map.append(h("div", { class: `slot ${side}`, style: `left:${x}%;top:${y}%` },
      h("button", { class: "ring", "data-slot": `${side}-${role}-champion`, title: slot.champion ?? `Pick ${label} champion`, "aria-label": `${label} champion: ${slot.champion ?? "none"}`,
        onclick: () => openSearch(side, role, "champion") },
        h("span", { class: "badge" }, BADGES[role]),
        slot.champion ? h("img", { src: icon(slot.champion), alt: slot.champion }) : "+"),
      h("button", { class: `who${slot.player ? "" : " empty"}`, "data-slot": `${side}-${role}-player`, "aria-label": `${label} player: ${slot.player ? playerName(slot.player) : "none"}`,
        onclick: () => openSearch(side, role, "player") }, slot.player ? playerLabel(slot.player) : "pick player")));
  }
  const done = filledCount(draft);
  return h("section", { class: "pick" },
    h("p", { class: "label" }, "Pick the draft: click a ring for the champion, the line under it for the player"),
    map,
    h("button", { class: "predict", disabled: done < 10, onclick: () => setHash("result", true) }, "PREDICT"),
    h("p", { class: "progress" }, done < 10 ? `${done} of 10 slots done` : "Ready"));
}

function openSearch(side, role, kind) {
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); closeSearch = null; };
  const refocus = () => document.querySelector(`[data-slot="${side}-${role}-${kind}"]`)?.focus();
  const onKey = (event) => {
    if (event.key === "Escape") { close(); refocus(); }
    if (event.key !== "Tab") return;
    // keep Tab inside the popover while it is open
    const focusable = [...panel.querySelectorAll("input, button:not([disabled])")];
    const [first, last] = [focusable[0], focusable.at(-1)];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const choose = (value) => {
    draft[side][role][kind] = value;
    setHash("pick", false);
    close();
    render();
    refocus();
  };
  const input = h("input", { type: "search", placeholder: kind === "champion" ? "Search champions" : "Search players", "aria-label": "Search" });
  const list = h("ul", { class: "results" });
  const sorts = h("div", { class: "sorts", role: "group", "aria-label": "Sort players" });
  const fill = () => {
    const items = kind === "champion" ? searchChampions(data, input.value, draft)
      : searchPlayers(data, input.value, role, draft, playerSort);
    const rows = [];
    let group;
    for (const item of items) {
      if (item.group !== undefined && item.group !== group && playerSort !== "role") {
        group = item.group;
        rows.push(h("li", { class: "group" }, group ?? (playerSort === "team" ? "No team" : "No league")));
      }
      rows.push(h("li", {},
        h("button", { disabled: item.taken && draft[side][role][kind] !== (item.name ?? item.id), onclick: () => choose(item.name ?? item.id) },
          kind === "champion" ? h("img", { src: icon(item.name), alt: "", loading: "lazy" }) : null,
          kind === "champion" ? item.name : item.label,
          item.inactive ? h("span", { class: "inactive", title: item.note, "aria-label": item.note }, " !") : null)));
    }
    list.replaceChildren(...rows);
    sorts.replaceChildren(...PLAYER_SORTS.map(([key, label]) => h("button", {
      class: key === playerSort ? "on" : "", "aria-pressed": key === playerSort ? "true" : "false",
      onclick: () => { playerSort = key; fill(); input.focus(); } }, label)));
  };
  input.addEventListener("input", fill);
  const panel = h("div", { class: "search", role: "dialog", "aria-modal": "true", "aria-label": `Pick ${side} ${ROLE_LABELS[role]} ${kind}` },
    h("h2", {}, `${side} ${ROLE_LABELS[role]} · ${kind}`), input,
    kind === "player" ? h("div", { class: "sortbar" }, h("span", { class: "muted" }, "Sort:"), sorts) : null,
    kind === "player" ? h("p", { class: "muted hint" }, "Type a name, a team (T1) or a league (LEC).") : null, list,
    draft[side][role][kind] ? h("button", { class: "clear", onclick: () => choose(null) }, "Clear this pick") : null);
  const backdrop = h("div", { class: "backdrop", onclick: (event) => { if (event.target === backdrop) { close(); refocus(); } } }, panel);
  closeSearch?.();
  closeSearch = close;
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  fill();
  input.focus();
}

// ── prediction page ────────────────────────────────────────────────────────

function curveSvg(curve) {
  const minutes = data.meta.landmarks.filter((m) => m > 0);
  const W = 320, H = 150, left = 34, right = 10, top = 10, bottom = 26;
  const x = (m) => left + ((m - minutes[0]) / (minutes.at(-1) - minutes[0])) * (W - left - right);
  const scale = curveScale(minutes.map((m) => curve[m]));
  const y = (p) => top + ((scale.hi - p) / (scale.hi - scale.lo)) * (H - top - bottom);
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Blue win chance if the game is still going at each minute" });
  for (const p of scale.ticks) {
    svg.append(el("line", { x1: left, x2: W - right, y1: y(p), y2: y(p), stroke: "#1f2b40" }));
    svg.append(el("text", { x: left - 6, y: y(p) + 4, "text-anchor": "end", fill: "#9aa4b2", "font-size": 10 }, `${Math.round(p * 100)}%`));
  }
  if (scale.lo < 0.5 && scale.hi > 0.5)
    svg.append(el("line", { x1: left, x2: W - right, y1: y(0.5), y2: y(0.5), stroke: "#556", "stroke-dasharray": "4 4" }));
  svg.append(el("polyline", { points: minutes.map((m) => `${x(m)},${y(curve[m])}`).join(" "), fill: "none", stroke: "#4da3ff", "stroke-width": 2.5 }));
  for (const m of minutes) {
    svg.append(el("circle", { cx: x(m), cy: y(curve[m]), r: 3.5, fill: "#4da3ff" }));
    svg.append(el("text", { x: x(m), y: H - 8, "text-anchor": "middle", fill: "#9aa4b2", "font-size": 10 }, `${m}m`));
  }
  return svg;
}

function lineupRows(blue, red, counterRows) {
  const rate = Object.fromEntries(counterRows.map((r) => [r.role, r]));
  return h("div", { class: "lineup-grid" }, ROLES.map((role, i) => {
    const [, bp, bc] = blue[i];
    const [, rp, rc] = red[i];
    const r = rate[role];
    return h("div", { class: "lineup-row" },
      h("div", { class: "pick-cell blue" }, h("img", { src: icon(bc), alt: bc }), h("span", {}, playerLabel(bp), h("br"), h("small", {}, bc))),
      h("div", { class: "vs" }, h("small", {}, ROLE_LABELS[role]),
        r ? h("span", { class: SIGN_CLASS[shownSign(100 * r.winRate - 50, 1)], title: `${r.matches.toLocaleString("en")} solo queue games` },
          `${(100 * r.winRate).toFixed(1)}%`) : h("span", { class: "muted", title: "not enough solo queue games" }, "-"),
        r ? h("span", { class: `edge ${SIGN_CLASS[shownSign(r.edge, 1)]}`, title: edgeNote(r) }, signedText(r.edge, 1)) : null),
      h("div", { class: "pick-cell red" }, h("span", {}, playerLabel(rp), h("br"), h("small", {}, rc)), h("img", { src: icon(rc), alt: rc })));
  }));
}

// tooltip for a lane's counter edge
const edgeNote = (r) => (shownSign(r.edge, 1) === 0 ? "No edge beyond both champions' overall strength"
  : `${r.edge > 0 ? r.a : r.b} gains ${Math.abs(r.edge).toFixed(1)} points beyond both champions' overall strength`)
  + (r.patches ? ` (${r.patches} patch${r.patches === 1 ? "" : "es"} with 100+ games)` : " (under 100 games on every patch)");

const fmt = (x) => (Number.isNaN(x) ? "none" : x.toFixed(3));
const signed = (x) => `${shownSign(x, 3) < 0 ? "-" : "+"}${Math.abs(x).toFixed(3)}`;

function mathView(blue, red) {
  const m = mathSteps(data, blue, red);
  const step = (label, detail, value) => h("div", { class: "line" }, h("span", {}, label, h("br"), h("small", { class: "muted" }, detail)),
    h("span", {}, signed(value)));
  const champs = m.champions.map((c) => `${c.name} ${signed(c.contribution)}`).join(", ");
  return h("details", { class: "math" }, h("summary", {}, "Show the math"),
    h("p", { class: "muted" }, "The model adds up a score in log-odds (positive favours blue), then turns it into a chance."),
    step("Player ratings", `blue average ${fmt(m.ratings.blue)} - red average ${fmt(m.ratings.red)} = ${signed(m.ratings.diff)}, x weight ${fmt(m.ratings.weight)}`,
      m.ratings.contribution),
    step("Champion mastery", m.mastery.fallback
      ? "a side has no mastery history, so the difference counts as 0"
      : `blue average level ${fmt(m.mastery.blue)} - red ${fmt(m.mastery.red)} = ${signed(m.mastery.diff)}, x weight ${fmt(m.mastery.weight)}`,
    m.mastery.contribution),
    step("Champion strength", `each pick's weight, added for blue and subtracted for red: ${champs}`,
      m.champions.reduce((s, c) => s + c.contribution, 0)),
    step("Blue side", "a fixed blue-side edge", m.side.contribution),
    h("div", { class: "line" }, h("strong", {}, "Total score"), h("strong", {}, signed(m.total))),
    m.stretch === null
      ? h("p", {}, `Chance = 1 / (1 + e^-score) = 1 / (1 + e^${(-m.total).toFixed(3)}) = ${(100 * m.p).toFixed(1)}% for blue.`)
      : h("p", {}, `Before recalibration: 1 / (1 + e^${(-m.total).toFixed(3)}) = ${(100 * m.raw).toFixed(1)}%. Recalibrated: `
        + `1 / (1 + e^-(${m.stretch.toFixed(3)} x score)) = ${(100 * m.p).toFixed(1)}% for blue.`),
    h("p", { class: "muted" }, m.points === null ? "Within half a point of 50%, so the breakdown is not split."
      : `Breakdown points: (chance - 50%) x each part / total score; for ratings ${(100 * m.p - 50).toFixed(1)} x ${signed(m.ratings.contribution)} / ${signed(m.total)} = ${m.points.ratings.toFixed(1)} pts.`),
    h("p", { class: "muted" }, "The curve uses a second set of weights with a term for each minute; see How it works."));
}

// one line per part plus the total, rounded so the lines add up to the total
function breakdownLines(points) {
  const shown = roundPoints(points, 1);
  const line = (label, v, strong) => {
    const sign = shownSign(v, 1);
    const text = sign === 0 ? "even" : `${sign > 0 ? "blue" : "red"} +${Math.abs(v).toFixed(1)} pts`;
    return h("div", { class: "line" }, h(strong ? "strong" : "span", {}, label), h("span", { class: SIGN_CLASS[sign] }, text));
  };
  const total = Object.values(points).reduce((a, b) => a + b, 0);
  return [...Object.entries(BREAKDOWN_LABELS).map(([key, label]) => line(label, shown[key], false)),
    line("Total (chance - 50%)", total, true)];
}

function resultView() {
  const blue = lineup(draft, "blue");
  const red = lineup(draft, "red");
  const { curve, row } = predictCurve(data, blue, red);
  const p0 = curve["0"];
  const b = breakdown(data, row, p0);
  const blueAhead = p0 >= 0.5;
  const counterRows = counters(data, blue, red);
  const notes = flags(data, blue, red);
  return h("section", { class: "result" },
    h("div", {},
      h("div", { class: "panel" }, h("p", { class: "label" }, "Lineups"), lineupRows(blue, red, counterRows),
        h("p", { class: "small" }, `Lane win rates (blue's champion vs red's): u.gg Master+ solo queue, patches `
          + `${(data.counters.patches ?? [data.counters.patch]).join(", ")}. The small number is the counter edge: how much better `
          + "than both champions' overall strength the matchup goes, so an overtuned champion does not look like a counter. "
          + "Context only, not used in the prediction.")),
      h("button", { class: "back", onclick: () => setHash("pick", true) }, "Back to the map (keeps your picks)")),
    h("div", { class: "panel" },
      h("div", { class: `pct ${blueAhead ? "blue" : "red"}` }, percent(blueAhead ? p0 : 1 - p0)),
      h("div", { class: "pct-label" }, `${blueAhead ? "BLUE" : "RED"} WIN CHANCE · PRE-GAME`),
      h("div", { class: "bar", role: "img", "aria-label": `Blue ${percent(p0)}, red ${percent(1 - p0)}` },
        h("div", { class: "b", style: `width:${100 * p0}%` }), h("div", { class: "r", style: `width:${100 * (1 - p0)}%` })),
      h("p", { class: "muted" }, `Blue ${percent(p0)} · Red ${percent(1 - p0)}`),
      h("p", { class: "label", style: "margin-top:14px" }, "If the game is still going at..."),
      h("div", { class: "curve" }, curveSvg(curve)),
      h("p", { class: "muted" }, "Blue's chance among games that last that long; the pre-game number above is the overall prediction."),
      h("p", { class: "label", style: "margin-top:14px" }, "Why this prediction"),
      b.points === null ? h("p", {}, "Too close to call.") : breakdownLines(b.points),
      mathView(blue, red),
      notes.length ? h("ul", { class: "flags" }, notes.map((n) => h("li", {}, n))) : null,
      data.meta.site_caveat ? h("p", { class: "small", style: "margin-top:14px" }, data.meta.site_caveat) : null,
      h("p", { class: "small" }, data.meta.caveat),
      h("p", { class: "small" }, `Ratings as of ${data.meta.run_date}.`)));
}

async function start() {
  try {
    const response = await fetch("data/site.json");
    if (!response.ok) throw new Error(`site.json: HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    app.replaceChildren(h("p", { class: "error" }, `Could not load the model data (${error.message}).`));
    return;
  }
  window.addEventListener("hashchange", render);
  render();
}

start();
