import { validateControllerUpdateCheckpoint as validateControllerUpdateCheckpointAt, type ControllerUpdateCheckpoint } from './controller-update-logic';
export { type ControllerUpdateCheckpoint, type ControllerUpdateRestore } from './controller-update-logic';

export function validateControllerUpdateCheckpoint(input: unknown, now = Date.now()): ControllerUpdateCheckpoint {
  return validateControllerUpdateCheckpointAt(input, now);
}
