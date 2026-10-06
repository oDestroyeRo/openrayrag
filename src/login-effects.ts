import type { UnityClient } from './login-logic';

export const LOGIN = 'Canvas/Login Screen/LoginBoxWindow';
export const USERNAME = `${LOGIN}/LoginBox/Login/Username/Title/InputField (TMP)`;
export const PASSWORD = `${LOGIN}/LoginBox/Login/Password/Title/InputField (TMP)`;
export const SERVER = `${LOGIN}/LoginBox/Server Settings/Username/Title/InputField (TMP)`;
export const CHARACTERS = 'Canvas/Login Screen/CharacterCreator';
export const SELECTION_PANE = `${CHARACTERS}/CharacterWindow/CharacterSelectPane`;
export const SELECTION_OK = `${SELECTION_PANE}/BottomBar/OkButton`;
const READY_PROBE = '__rayrag_login_ready_probe__';

// Unity's WebGL SendMessage reports missing objects through its console, not a
// JavaScript exception. Observe only this synchronous call, retaining no log text.
function dispatch(client: UnityClient, object: string, method: string, value?: string | number) {
  let missing = false;
  let present = false;
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      if (args.some(arg => typeof arg === 'string' && /SendMessage:|Failed to execute SendMessage/.test(arg))) {
        missing = true;
        present ||= method === READY_PROBE && args.some(arg => typeof arg === 'string'
          && arg.includes(`SendMessage: object ${object} does not have receiver for function ${READY_PROBE}!`));
      }
      else originals[level](...args);
    };
  }
  try { client.SendMessage(object, method, value); } catch { missing = true; }
  finally { Object.assign(console, originals); }
  return { sent: !missing, present };
}

export function unityMessage(client: UnityClient, object: string, method: string, value?: string | number): boolean {
  return dispatch(client, object, method, value).sent;
}

export function objectReady(client: UnityClient, object: string): boolean {
  // A nonexistent method is a harmless positive probe: the native diagnostic
  // distinguishes an active object from one that has not finished loading.
  return dispatch(client, object, READY_PROBE).present;
}

export function loginReady(client: UnityClient): boolean {
  return objectReady(client, LOGIN);
}

export class SelectionDispatchError extends Error {
  constructor(stage: 'slot' | 'enter') {
    super(stage === 'slot'
      ? 'Could not select the requested slot. Choose your character in the game window.'
      : 'Could not enter with the selected character. Continue in the game window.');
  }
}
