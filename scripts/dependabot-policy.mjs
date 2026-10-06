// Pure dependency-update identity and conventional-title policy.
export const repository = 'oDestroyeRo/openrayrag';

/** @param {import("./tooling-domain-values.mjs").DependabotPrDto} pr */
export function mergeTitle(pr) {
  const ecosystem = /^dependabot\/(bun|cargo|github_actions)\//.exec(pr.head?.ref ?? '')?.[1];
  const title = pr.title;
  if (!ecosystem || typeof title !== 'string' || title.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(title) || title !== title.trim()) return undefined;
  const conventional = /^(chore|ci)\((deps|deps-dev)\): (\S.*)$/.exec(title);
  if (!conventional) return undefined;
  const [, type, scope] = conventional;
  if (ecosystem === 'github_actions') return type === 'ci' && scope === 'deps' ? title : undefined;
  if (type !== 'chore') return undefined;
  if (pr.head?.ref?.startsWith('dependabot/bun/tools/release/') && scope !== 'deps-dev') return undefined;
  return title;
}

/** @param {import("./tooling-domain-values.mjs").DependabotPrDto} pr @param {string} testedHead */
export function rejectionReason(pr, testedHead) {
  if (pr.user?.login !== 'dependabot[bot]' || pr.user?.type !== 'Bot' ||
      pr.base?.ref !== 'main' || pr.base?.repo?.full_name !== repository ||
      pr.head?.repo?.full_name !== repository || !pr.head?.ref?.startsWith('dependabot/')) {
    return 'not a repository Dependabot update';
  }
  if (pr.head?.sha !== testedHead) return 'PR changed after the tested commit';
  if (pr.draft || (pr.state !== 'open' && !pr.merged)) return 'PR is draft or closed';
  if (!mergeTitle(pr)) return 'Dependabot title or ecosystem does not match dependency policy';
}
