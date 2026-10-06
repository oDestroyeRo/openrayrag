import { validateControllerUpdateCheckpoint as validateControllerUpdateCheckpointAt, type ValidatedControllerUpdateCheckpoint } from './controller-update-logic';
export { type ControllerUpdateCheckpoint, type ValidatedControllerUpdateCheckpoint, type ControllerUpdateRestore } from './controller-update-logic';

export function validateControllerUpdateCheckpoint(input: unknown, now = Date.now()): ValidatedControllerUpdateCheckpoint {
  return validateControllerUpdateCheckpointAt(input, now);
}
