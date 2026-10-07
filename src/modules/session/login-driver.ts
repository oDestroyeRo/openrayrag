import { SOCKET_URL } from '../protocol/protocol';
import type { UnityClient, LoginDriver, CharacterSlot } from './login-logic';
import {
  LOGIN,
  USERNAME,
  PASSWORD,
  SERVER,
  CHARACTERS,
  SELECTION_PANE,
  SELECTION_OK,
  objectReady,
  unityMessage,
  SelectionDispatchError,
} from './login-effects';

export function loginDriver(client: UnityClient): LoginDriver {
  let selectedSlot: CharacterSlot | null = null;
  let enterAttempted = false;
  const selectionReady = () =>
    objectReady(client, CHARACTERS) &&
    objectReady(client, SELECTION_PANE) &&
    objectReady(client, SELECTION_OK);
  const message = (object: string, method: string, value?: string | number) => {
    if (!unityMessage(client, object, method, value)) throw new Error('Game interface unavailable');
  };
  return {
    async prepare(profile, active) {
      if (!active()) return;
      // SendMessage resolves only active objects, so expose the server input first.
      message(LOGIN, 'ChangeTabs', 2);
      message(SERVER, 'SetTextWithoutNotify', SOCKET_URL);
      message(LOGIN, 'ChangeTabs', 0);
      message(USERNAME, 'SetTextWithoutNotify', profile.username);
      message(PASSWORD, 'SetTextWithoutNotify', profile.password);
    },
    submit: () => message(LOGIN, 'AttemptLogin'),
    selectionReady,
    select(slot) {
      if (enterAttempted) return true;
      // Recheck immediately before either dispatch. A shared parent also hosts
      // character creation, so its existence alone cannot prove selection ready.
      if (!selectionReady()) return false;
      if (selectedSlot === null) {
        if (!unityMessage(client, CHARACTERS, 'SetCharacterInfo', slot))
          throw new SelectionDispatchError('slot');
        selectedSlot = slot;
        // Let Unity finish applying the selected slot before the enter request.
        return false;
      }
      if (selectedSlot !== slot) throw new SelectionDispatchError('slot');
      enterAttempted = true;
      if (!unityMessage(client, CHARACTERS, 'ClickOk')) throw new SelectionDispatchError('enter');
      return true;
    },
  };
}
