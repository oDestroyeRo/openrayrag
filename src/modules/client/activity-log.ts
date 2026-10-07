import type { LogEntry } from '../automation/engine';

/** Keep unchanged observations mounted; retain values rather than shared entries. */
export class ActivityLog {
  private entries: LogEntry[] | null = null;
  private emptyText = '';
  constructor(private readonly list: HTMLElement) {}

  render(entries: readonly LogEntry[], emptyText = 'No activity observed yet.'): void {
    const visible = entries.slice(0, 50);
    if (
      this.entries?.length === visible.length &&
      this.emptyText === emptyText &&
      visible.every(
        (entry, index) =>
          entry.at === this.entries![index]!.at && entry.text === this.entries![index]!.text,
      )
    )
      return;
    this.list.replaceChildren();
    for (const entry of visible) {
      const li = document.createElement('li'),
        time = document.createElement('time'),
        text = document.createElement('span');
      time.textContent = new Date(entry.at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      text.textContent = entry.text;
      li.append(time, text);
      this.list.append(li);
    }
    if (!visible.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = emptyText;
      this.list.append(empty);
    }
    this.entries = visible.map((entry) => ({ at: entry.at, text: entry.text }));
    this.emptyText = emptyText;
  }
}
