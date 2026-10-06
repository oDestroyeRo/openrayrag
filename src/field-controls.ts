import { searchGrid } from './navigation';
import type { WalkGrid } from './navigation-logic';
import { canStartField as canStartFieldWithGrid, type FieldStartState } from './field-controls-logic';
export { settingsWithFieldMap } from './field-controls-logic';

export function canStartField(state: FieldStartState, gridFor: (map: string) => WalkGrid | null = searchGrid): boolean {
  return canStartFieldWithGrid(state, gridFor);
}
