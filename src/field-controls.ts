import { publishedGrid } from './navigation-logic';
import type { WalkGrid } from './navigation-logic';
import { canStartField as canStartFieldWithGrid, type FieldStartState } from './field-controls-logic';
export { settingsWithFieldMap } from './field-controls-logic';

export function canStartField(state: FieldStartState, gridFor: (map: string) => WalkGrid | null = publishedGrid): boolean {
  return canStartFieldWithGrid(state, gridFor);
}
