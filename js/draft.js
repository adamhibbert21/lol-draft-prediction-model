// Draft state: who and what is picked in each slot, the shareable link hash, and the pick searches.

import { ROLES } from "./model.js";

export const SIDES = ["blue", "red"];
export const ROLE_LABELS = { Top: "Top", Jungle: "Jungle", Mid: "Mid", Bot: "ADC", Support: "Support" };

export function emptyDraft() {
  const side = () => Object.fromEntries(ROLES.map((role) => [role, { champion: null, player: null }]));
  return { blue: side(), red: side() };
}

const slots = (draft) => SIDES.flatMap((side) => ROLES.map((role) => draft[side][role]));

export function filledCount(draft) {
  return slots(draft).filter((s) => s.champion && s.player).length;
}

export function isComplete(draft) {
  return filledCount(draft) === 10;
}

export function lineup(draft, side) {
  return ROLES.map((role) => [role, draft[side][role].player, draft[side][role].champion]);
}

const enc = (value) => encodeURIComponent(value ?? "");

// "b=Top:player:Champion,...;r=..." with each name URI-encoded
export function toHash(draft) {
  return SIDES.map((side) => `${side[0]}=` + ROLES.map((role) =>
    `${role}:${enc(draft[side][role].player)}:${enc(draft[side][role].champion)}`).join(",")).join(";");
}

export function fromHash(hash, data) {
  const draft = emptyDraft();
  const players = new Set(data.players.map((p) => p.id));
  const champions = new Set(data.champions.map((c) => c.name));
  const usedPlayers = new Set();
  const usedChampions = new Set();
  const decode = (value) => { try { return decodeURIComponent(value); } catch { return ""; } };
  for (const part of hash.replace(/^#/, "").split(";")) {
    const [key, value] = part.split("=");
    const side = SIDES.find((s) => s[0] === key);
    if (!side || !value) continue;
    for (const slot of value.split(",")) {
      const [role, player, champion] = slot.split(":").map(decode);
      if (!ROLES.includes(role)) continue;
      if (players.has(player) && !usedPlayers.has(player)) {
        draft[side][role].player = player;
        usedPlayers.add(player);
      }
      if (champions.has(champion) && !usedChampions.has(champion)) {
        draft[side][role].champion = champion;
        usedChampions.add(champion);
      }
    }
  }
  return draft;
}

// lower case with punctuation and spaces removed, so "ksante" finds "K'Sante"
const fold = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function searchChampions(data, query, draft) {
  const q = fold(query);
  const taken = new Set(slots(draft).map((s) => s.champion));
  return data.champions.filter((c) => fold(c.name).includes(q)).sort(byName)
    .map((c) => ({ name: c.name, id: c.id, taken: taken.has(c.name) }));
}

export const INACTIVE_MONTHS = 12;

// "Last pro game over N months ago" (N rounded down, so it never reads as the threshold itself) for a player with no pro
// game in over INACTIVE_MONTHS, else null
export function inactiveNote(player) {
  const months = player?.months_since;
  return months !== null && months !== undefined && months > INACTIVE_MONTHS ? `Last pro game over ${Math.floor(months)} months ago` : null;
}

export const LEAGUES = ["LCK", "LPL", "LEC", "LCS"];

// empty values sort last
const byText = (a, b) => (!a) - (!b) || (a || "").localeCompare(b || "", undefined, { sensitivity: "base" });
const leagueRank = (r) => (LEAGUES.includes(r) ? LEAGUES.indexOf(r) : LEAGUES.length);
const PLAYER_SORTS = {
  role: (role) => (a, b) => (b.role === role) - (a.role === role) || byName(a, b),
  team: () => (a, b) => byText(a.team, b.team) || byName(a, b),
  region: () => (a, b) => leagueRank(a.region) - leagueRank(b.region) || byText(a.team, b.team) || byName(a, b),
};

// the most common spelling of each team name, ignoring case ("EDward Gaming" -> "Edward Gaming")
const canonicalCache = new WeakMap();
function canonicalTeams(data) {
  if (!canonicalCache.has(data)) {
    const counts = new Map();
    for (const { team } of data.players) {
      if (!team) continue;
      const key = team.toLowerCase();
      if (!counts.has(key)) counts.set(key, new Map());
      counts.get(key).set(team, (counts.get(key).get(team) ?? 0) + 1);
    }
    const best = new Map([...counts].map(([key, spellings]) => [key, [...spellings].sort((a, b) => b[1] - a[1])[0][0]]));
    canonicalCache.set(data, (team) => (team ? best.get(team.toLowerCase()) : team));
  }
  return canonicalCache.get(data);
}

// query matches name, team or league; sort is "role" (the slot's role first), "team" or "region" (grouped)
export function searchPlayers(data, query, role, draft, sort = "role") {
  const q = fold(query);
  const taken = new Set(slots(draft).map((s) => s.player));
  const teamName = canonicalTeams(data);
  return data.players.filter((p) => [p.name, p.team, p.region].some((text) => text && fold(text).includes(q)))
    .sort(PLAYER_SORTS[sort](role))
    .map((p) => ({
      id: p.id, label: [p.name, p.team, p.region, ROLE_LABELS[p.role]].filter(Boolean).join(" · "), taken: taken.has(p.id),
      inactive: inactiveNote(p) !== null, note: inactiveNote(p),
      group: sort === "role" ? null : (sort === "team" ? teamName(p.team) : p.region) || null,
    }));
}
