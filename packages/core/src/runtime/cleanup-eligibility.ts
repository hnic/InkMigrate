import type { ArtifactKind, ArtifactStatus } from '../domain/states.js';
import type { SourceItemQuality } from '../domain/models.js';

export interface EligibilityInput {
  // 受控值类型复用 domain 单一真相源（ARTIFACT_KINDS / ARTIFACT_STATUSES /
  // SourceItemQuality）：调用方传近失值（'Note'、'verified '）在编译期即暴露，
  // 而非静默漏过 §14.4 数据完整性关键的资格门。
  artifactKind: ArtifactKind;
  artifactStatus: ArtifactStatus;
  sourceItemQuality: SourceItemQuality;
  noteExists: boolean;
  noteNonZero: boolean;
  yamlParseable: boolean;
  hasSourceIdOrUrl: boolean;
  // 双否定命名沿用 §14.4 检查清单的原文表述（"无未解决冲突 / 不在过渡态 /
  // 未确认取消收藏"），该 API 形态已被测试固化；调用方须直接传检查结论。
  noUnresolvedConflict: boolean;
  notInTransitionalState: boolean;
  notAlreadyUnfavorited: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * 不合格原因的稳定文案。这些字符串是模块的对外输出，可能被清理日志/审计
 * 记录持久化或被消费方断言；导出为常量使契约显式——改文案即是破坏性变更。
 */
export const ELIGIBILITY_REASONS = {
  NOT_NOTE_KIND: 'artifact_kind is not "note"',
  NOT_VERIFIED: 'artifact_status is not "verified"',
  NOT_FULL_QUALITY: 'source_item quality is not "full"',
  NOTE_MISSING: 'note file does not exist',
  NOTE_ZERO_BYTES: 'note file is zero bytes',
  YAML_UNPARSEABLE: 'YAML frontmatter not parseable',
  NO_SOURCE_ID_OR_URL: 'no source_item_id or canonical_url',
  DB_TARGET_INCONSISTENT: 'database and target file inconsistent',
  UNRESOLVED_CONFLICT: 'unresolved conflict exists',
  TRANSITIONAL_STATE: 'item in transitional state',
  ALREADY_UNFAVORITED: 'already confirmed unfavorited',
} as const;

/**
 * §14.4 候选资格检查。
 *
 * 当前仅由测试引用（§14.4 清理管线尚未接线）；接入点是 source-toutiao 的
 * cleanup 编排：判定候选后再执行 §14.4 删除流程，此处刻意先行落地纯函数。
 */
export function checkEligibility(i: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  if (i.artifactKind !== 'note') reasons.push(ELIGIBILITY_REASONS.NOT_NOTE_KIND);
  if (i.artifactStatus !== 'verified') reasons.push(ELIGIBILITY_REASONS.NOT_VERIFIED);
  if (i.sourceItemQuality !== 'full') reasons.push(ELIGIBILITY_REASONS.NOT_FULL_QUALITY);
  if (!i.noteExists) reasons.push(ELIGIBILITY_REASONS.NOTE_MISSING);
  if (!i.noteNonZero) reasons.push(ELIGIBILITY_REASONS.NOTE_ZERO_BYTES);
  if (!i.yamlParseable) reasons.push(ELIGIBILITY_REASONS.YAML_UNPARSEABLE);
  if (!i.hasSourceIdOrUrl) reasons.push(ELIGIBILITY_REASONS.NO_SOURCE_ID_OR_URL);
  if (!i.dbTargetConsistent) reasons.push(ELIGIBILITY_REASONS.DB_TARGET_INCONSISTENT);
  if (!i.noUnresolvedConflict) reasons.push(ELIGIBILITY_REASONS.UNRESOLVED_CONFLICT);
  if (!i.notInTransitionalState) reasons.push(ELIGIBILITY_REASONS.TRANSITIONAL_STATE);
  if (!i.notAlreadyUnfavorited) reasons.push(ELIGIBILITY_REASONS.ALREADY_UNFAVORITED);
  return { eligible: reasons.length === 0, reasons };
}
