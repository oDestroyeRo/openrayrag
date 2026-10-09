import type { ReadinessAction, ReadinessRow } from './farming-readiness-logic';
import type { ClientShell } from './client-shell';

export function navigateFarmingReadiness(
  action: ReadinessAction,
  root: HTMLElement,
  shell: Pick<ClientShell, 'showPage' | 'showBotSection'>,
): void {
  if (action === 'account') {
    shell.showPage('settings');
    root.querySelector<HTMLDetailsElement>('#signin-panel')!.open = true;
    const control = root.querySelector<HTMLElement>('#auto-reconnect')!;
    control.focus();
    control.scrollIntoView({ block: 'nearest' });
    return;
  }
  shell.showPage('bot');
  root.querySelector<HTMLButtonElement>('#setup-tab-form')!.click();
  shell.showBotSection(
    action === 'recovery' ? 'recovery' : action === 'supply' ? 'inventory' : 'workflows',
  );
  const control = root.querySelector<HTMLElement>(
    `[data-setting="${action === 'recovery' ? 'respawn.maxDeaths' : action === 'supply' ? 'supply.enabled' : 'limits.minutes'}"]`,
  );
  for (let ancestor = control?.parentElement; ancestor; ancestor = ancestor.parentElement)
    if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true;
  control?.focus();
  control?.scrollIntoView({ block: 'nearest' });
}

export interface ReadinessGroup {
  readonly label: string;
  readonly rows: readonly ReadinessRow[];
}
const labels: Record<ReadinessAction, string> = {
  limits: 'Run limits',
  recovery: 'Recovery',
  supply: 'Loot & supplies',
  account: 'Account & reconnect',
};

/** Navigation-only review. No settings, Start, game or allowance mutation ports. */
export class FarmingReadiness {
  private signature = '';
  private warnings = '';
  constructor(
    private readonly panel: HTMLDetailsElement,
    private readonly summary: HTMLElement,
    private readonly list: HTMLElement,
    private readonly navigate: (action: ReadinessAction) => void,
  ) {}
  render(groups: readonly ReadinessGroup[]): void {
    const signature = JSON.stringify(groups);
    this.panel.hidden = groups.every((group) => group.rows.length === 0);
    if (signature === this.signature) return;
    const warnings = groups.flatMap((group) => group.rows.filter((row) => row.severity !== 'info'));
    const warningIds = JSON.stringify(warnings.map((row) => row.id + row.title));
    this.summary.textContent = warnings.length
      ? `Farming readiness · ${warnings.length} ${warnings.length === 1 ? 'setting' : 'settings'} to review`
      : 'Farming readiness · review limits & supplies';
    if (warnings.length && warningIds !== this.warnings) this.panel.open = true;
    this.warnings = warningIds;
    this.list.replaceChildren();
    const document = this.list.ownerDocument;
    for (const group of groups) {
      if (!group.rows.length) continue;
      const heading = document.createElement('h4');
      heading.textContent = group.label;
      const rows = document.createElement('ul');
      rows.className = 'readiness-list';
      for (const item of [
        ...group.rows.filter((row) => row.severity !== 'info'),
        ...group.rows.filter((row) => row.severity === 'info'),
      ]) {
        const row = document.createElement('li'),
          title = document.createElement('strong'),
          detail = document.createElement('span'),
          link = document.createElement('button');
        row.dataset.severity = item.severity;
        title.textContent = `${item.severity === 'error' ? 'Conflict · ' : item.severity === 'warning' ? 'Review · ' : ''}${item.title}: `;
        detail.textContent = item.detail;
        link.type = 'button';
        link.className = 'text-button';
        link.dataset.clientNavigation = 'readiness';
        link.textContent = labels[item.action];
        link.addEventListener('click', () => this.navigate(item.action));
        row.append(title, detail, link);
        rows.append(row);
      }
      this.list.append(heading, rows);
    }
    this.signature = signature;
  }
}
