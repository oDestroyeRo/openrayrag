import { MAX_TARGETS } from '../automation/engine';
import type { MapInfo, MapMonster } from '../navigation/map-data';

export class MapTargets {
  map = '';
  private session = '';
  private configured = { map: '', ids: new Set<number>() };
  get configuredMap(): string {
    return this.configured.map;
  }
  get configuredIds(): number[] {
    return [...this.configured.ids];
  }
  restore(map: string, ids: readonly number[]): void {
    this.configured = { map, ids: new Set(ids) };
    this.selected = new Set(this.map === map ? ids : []);
  }
  private remember(): void {
    this.configured = { map: this.map, ids: new Set(this.selected) };
  }
  private monsters = new Map<number, MapMonster>();
  private selected = new Set<number>();
  private level: number | null = null;
  private levelDifference = 1;

  setLevelDifference(value: number): void {
    if (Number.isInteger(value) && value >= -100 && value <= 100) this.levelDifference = value;
  }

  update(session: string, info: MapInfo, level: number | null): void {
    if (session !== this.session || info.code !== this.map) {
      this.monsters.clear();
      this.selected = new Set(info.code === this.configured.map ? this.configured.ids : []);
    }
    this.session = session;
    this.map = info.code;
    this.level = level;
    // Retain types already observed here when they leave view. Their live count
    // becomes zero, and they can never be attacked without a live entity.
    for (const monster of this.monsters.values()) monster.visibleCount = 0;
    for (const monster of info.monsters) this.monsters.set(monster.classId, { ...monster });
  }
  get options(): MapMonster[] {
    return [...this.monsters.values()].sort(
      (a, b) => a.level - b.level || a.name.localeCompare(b.name) || a.classId - b.classId,
    );
  }
  eligible(id: number): boolean {
    const monster = this.monsters.get(id);
    return !!monster && this.level !== null && monster.level <= this.level + this.levelDifference;
  }
  checked(id: number): boolean {
    return this.selected.has(id);
  }
  get ids(): number[] {
    return [...this.selected].filter((id) => this.eligible(id));
  }
  select(id: number, checked: boolean): void {
    if (!checked) {
      if (this.selected.delete(id)) this.remember();
    } else if (this.eligible(id) && !this.selected.has(id) && this.selected.size < MAX_TARGETS) {
      this.selected.add(id);
      this.remember();
    }
  }
  clear(): void {
    this.selected.clear();
    this.remember();
  }
  selectEligible(): void {
    this.selected = new Set(
      this.options
        .filter((monster) => this.eligible(monster.classId))
        .slice(0, MAX_TARGETS)
        .map((monster) => monster.classId),
    );
    this.remember();
  }
}
