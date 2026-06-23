export type SecondPassResult = 'confirmed_absent' | 'still_present' | 'unable_to_confirm';

/** §14.11 二次扫描结果 → 最终清理状态。 */
export function resolveSecondPassResult(result: SecondPassResult): string {
  switch (result) {
    case 'confirmed_absent': return 'unfavorited_verified';
    case 'still_present': return 'verification_failed';
    case 'unable_to_confirm': return 'action_result_unknown';
  }
}
