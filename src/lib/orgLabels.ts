import type { NodeNature, OrgTreeNode } from "../services/nodes";
import type { Person } from "../services/people";
import type { Rank } from "../services/ranks";

// Names the CEO types at runtime live in the data, in both languages; no
// reviewer sees them, so there is no i18n key to fall back on. English falls
// back to Vietnamese rather than rendering an empty label.
export function nodeLabel(node: OrgTreeNode, locale: string): string {
  return locale === "en" ? (node.name_en ?? node.name) : node.name;
}

export function rankLabel(rank: Rank, locale: string): string {
  return locale === "en" ? (rank.name_en ?? rank.name_vi) : rank.name_vi;
}

export function natureLabel(nature: NodeNature, locale: string): string {
  return locale === "en" ? nature.name_en : nature.name_vi;
}

export function natureLabelFor(
  natures: NodeNature[],
  key: string | null,
  locale: string,
): string | null {
  if (!key) return null;
  const match = natures.find((nature) => nature.key === key);
  return match ? natureLabel(match, locale) : key;
}

export function rankLabelForKey(ranks: Rank[], key: string, locale: string): string {
  const match = ranks.find((rank) => rank.key === key);
  return match ? rankLabel(match, locale) : key;
}

// org_tree()'s holder CTE joins straight to persons on the latest
// position_holders row and never checks status -- a departed or suspended
// occupant keeps reading as a plain staffed seat everywhere node.seats is
// drawn. Cheapest client-side guard: look the occupant up here and let each
// screen render a status pill instead of silence. Built once per persons
// snapshot rather than searched per seat.
export function personStatusById(persons: Person[]): Map<string, Person["status"]> {
  return new Map(persons.map((person) => [person.id, person.status]));
}

// null for "active" (or unknown -- RLS may hide the person from this caller
// entirely, which is not the same claim as "they are still active" but is the
// same rendering: a plain staffed seat, same as today).
export function seatOccupantStatusTone(
  status: Person["status"] | undefined,
): "warning" | "danger" | null {
  if (status === "suspended") return "warning";
  if (status === "departed") return "danger";
  return null;
}
