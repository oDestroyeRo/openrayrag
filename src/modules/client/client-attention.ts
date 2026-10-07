import type { AttentionAction, AttentionItem } from './client-attention-logic';

const actionLabel: Record<AttentionAction, string> = {
  account: 'Review account',
  setup: 'Review setup',
  recovery: 'Review recovery',
  limits: 'Review run limits',
  supply: 'Review supply trip',
  tools: 'Review tools',
};

/** Retains unchanged cards; its only action is navigation supplied by the shell owner. */
export class ClientAttention {
  private signature = '';
  constructor(
    private readonly panel: HTMLElement,
    private readonly list: HTMLElement,
    private readonly navigate: (action: AttentionAction) => void,
  ) {}

  render(items: readonly AttentionItem[]): void {
    const signature = JSON.stringify(items);
    this.panel.hidden = items.length === 0;
    if (signature === this.signature) return;
    const document = this.list.ownerDocument;
    this.list.replaceChildren();
    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'console-attention-item';
      row.dataset.severity = item.severity;
      const copy = document.createElement('div'),
        title = document.createElement('strong'),
        detail = document.createElement('p'),
        next = document.createElement('p');
      title.textContent = item.title;
      detail.textContent = item.detail;
      next.textContent = item.nextStep;
      next.className = 'hint';
      copy.append(title, detail, next);
      row.append(copy);
      if (item.action) {
        const action = item.action;
        const button = document.createElement('button');
        button.id = 'console-attention-' + item.id;
        button.type = 'button';
        button.className = 'secondary';
        button.dataset.clientNavigation = 'attention';
        button.textContent = actionLabel[action];
        button.addEventListener('click', () => this.navigate(action));
        row.append(button);
      }
      this.list.append(row);
    }
    this.signature = signature;
  }
}
