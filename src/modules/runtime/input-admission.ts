import { advanceInputDebt, recoveryInputAvailable, type InputDebt } from './input-admission-logic';

/** Conservative estimate of possibly sent input; it never acknowledges an action. */
export class InputAdmission {
  private state: InputDebt = { milliseconds: 0, at: null, active: false, pending: 0 };
  private generation = 0;
  constructor(private readonly now: () => number) {}

  connectionChanged(): void {
    this.generation++;
    this.state = { milliseconds: 0, at: null, active: false, pending: 0 };
  }

  observe(now: number, active: boolean): void {
    this.state = advanceInputDebt(this.state, now, active);
  }

  recoveryAvailable(now: number, active: boolean): boolean {
    return recoveryInputAvailable(advanceInputDebt(this.state, now, active));
  }

  dispatch(cost: number, send: () => unknown): unknown {
    if (cost === 0) return send();
    const generation = this.generation;
    // Charge before delegation, including a write that reaches the socket then
    // throws. Keep all debt frozen while any charged native write is pending.
    this.state = {
      ...this.state,
      milliseconds: Math.min(Number.MAX_SAFE_INTEGER, this.state.milliseconds + cost),
      pending: this.state.pending + 1,
    };
    const settle = () => {
      if (generation !== this.generation) return;
      this.state = advanceInputDebt(this.state, this.now(), this.state.active);
      this.state = { ...this.state, pending: this.state.pending - 1 };
    };
    try {
      const result = send();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function')
        void Promise.resolve(result).then(settle, settle);
      else settle();
      return result;
    } catch (error) {
      settle();
      throw error;
    }
  }
}
