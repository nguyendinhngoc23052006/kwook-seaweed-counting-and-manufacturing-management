import type { NodeNature, OrgTreeNode } from "../services/nodes";
import type { Rank } from "../services/positions";

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
