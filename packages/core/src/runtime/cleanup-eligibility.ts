export interface EligibilityInput {
  artifactKind: string;
  artifactStatus: string;
  sourceItemQuality: string;
  noteExists: boolean;
  noteNonZero: boolean;
  yamlParseable: boolean;
  hasSourceIdOrUrl: boolean;
  dbTargetConsistent: boolean;
  noUnresolvedConflict: boolean;
  notInTransitionalState: boolean;
  notAlreadyUnfavorited: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/** §14.4 候选资格检查。 */
export function checkEligibility(i: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (i.artifactKind !== 'note') reasons.push('artifact_kind is not "note"');
  if (i.artifactStatus !== 'verified') reasons.push('artifact_status is not "verified"');
  if (i.sourceItemQuality !== 'full') reasons.push('source_item quality is not "full"');
  if (!i.noteExists) reasons.push('note file does not exist');
  if (!i.noteNonZero) reasons.push('note file is zero bytes');
  if (!i.yamlParseable) reasons.push('YAML frontmatter not parseable');
  if (!i.hasSourceIdOrUrl) reasons.push('no source_item_id or canonical_url');
  if (!i.dbTargetConsistent) reasons.push('database and target file inconsistent');
  if (!i.noUnresolvedConflict) reasons.push('unresolved conflict exists');
  if (!i.notInTransitionalState) reasons.push('item in transitional state');
  if (!i.notAlreadyUnfavorited) reasons.push('already confirmed unfavorited');
  return { eligible: reasons.length === 0, reasons };
}
