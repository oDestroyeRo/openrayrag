import { MAX_TARGETS } from './engine';
import { type MapInfo, type MapMonster } from './map-data';

export class MapTargets {
  map = '';
  private session = '';
  private monsters = new Map<number, MapMonster>();
  private selected = new Set<number>();
  private level: number | null = null;
  private levelDifference = 1;

  setLevelDifference(value: number): void {
    if (Number.isInteger(value) && value >= -100 && value <= 100) this.levelDifference = value;
  }

  update(session: string, info: MapInfo, level: number | null): void {
    if (session !== this.session || info.code !== this.map) {
      this.monsters.clear(); this.selected.clear();
    }
    this.session = session; this.map = info.code; this.level = level;
    // Retain types already observed here when they leave view. Their live count
    // becomes zero, and they can never be attacked without a live entity.
    for (const monster of this.monsters.values()) monster.visibleCount = 0;
    for (const monster of info.monsters) this.monsters.set(monster.classId, { ...monster });
  }
  get options(): MapMonster[] {
    return [...this.monsters.values()].sort((a,b) => a.level - b.level || a.name.localeCompare(b.name) || a.classId - b.classId);
  }
  eligible(id: number): boolean {
    const monster = this.monsters.get(id);
    return !!monster && this.level !== null && monster.level <= this.level + this.levelDifference;
  }
  checked(id: number): boolean { return this.selected.has(id); }
  get ids(): number[] { return [...this.selected].filter(id => this.eligible(id)); }
  select(id: number, checked: boolean): void {
    if (!checked) this.selected.delete(id);
    else if (this.eligible(id) && (this.selected.has(id) || this.selected.size < MAX_TARGETS)) this.selected.add(id);
  }
  clear(): void { this.selected.clear(); }
  selectEligible(): void {
    this.selected = new Set(this.options.filter(monster => this.eligible(monster.classId)).slice(0,MAX_TARGETS).map(monster => monster.classId));
  }
}
