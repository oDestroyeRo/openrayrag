import { describe, expect, it, vi } from 'vitest';
import {
  actorId,
  bagId,
  itemId,
  milliseconds,
  revisionFor,
  seconds,
  skillId,
  worldId,
} from '../../shared/domain-values';
import {
  checkedProfile,
  profileId,
  profileName,
  profileSavedAt,
  type ProfileId,
  type ProfileName,
  type ProfileSavedAt,
} from '../settings/profiles-logic';
import {
  formDocument,
  formRevision,
  nextFormSave,
  type FormRevision,
} from '../settings/current-form-logic';
import { CurrentForm } from '../settings/current-form';
import {
  characterSlot,
  loginPacketStatus,
  selectionReadiness,
  validateLoginProfile,
} from '../session/login-logic';
import { LoginController } from '../session/login';
import { gameSessionId, type GameSessionId } from './game-status';
import { closeRequest, type CloseToken } from '../settings/settings-close-logic';
import { SettingsClose } from '../settings/settings-close';
import {
  updateAccount,
  updateRequestId,
  type UpdateRequestId,
} from '../update/update-continuation-logic';
import { DEFAULT_SETTINGS } from '../settings/settings';
import { parseMapCatalog } from '../navigation/map-data-logic';
import { BUILTIN_SERVICES } from '../services/npc-services-logic';
import {
  checkedSavedService,
  savedServiceId,
  serviceContractId,
  type ServiceContractId,
} from '../services/npc-service-store-logic';
import { NpcServiceStore } from '../services/npc-service-store';
import { carriedRecoveryItem, recoveryInventory } from '../recovery/recovery-item-ui-logic';
import { actorInput } from './feature-ui-logic';

const settings = () => ({
  ...structuredClone(DEFAULT_SETTINGS),
  map: 'prt_fild08',
  targets: [4000],
});
const token = '00000000-0000-0000-0000-000000000001';

describe('frontend admitted domains', () => {
  it('preserves profile normalization, metadata bounds and document shape', () => {
    expect(profileName('  Field  ')).toBe('Field');
    expect(profileId('profile_1-A')).toBe('profile_1-A');
    expect(profileSavedAt(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ['', '../profile', 'a'.repeat(65), 1])
      expect(() => profileId(value)).toThrow('Invalid profile name or metadata.');
    for (const value of ['', ' ', 'a'.repeat(49), 'name\u007f'])
      expect(() => profileName(value)).toThrow('Invalid profile name or metadata.');
    for (const value of [-1, 1.5, Infinity, '1'])
      expect(() => profileSavedAt(value)).toThrow('Invalid profile name or metadata.');
    const input = settings(),
      checked = checkedProfile({
        id: 'saved',
        name: ' Field ',
        character: '',
        savedAt: 0,
        settings: input,
      });
    input.targets.push(4012);
    expect(checked.settings.targets).toEqual([4000]);
    expect(JSON.parse(JSON.stringify(checked))).toMatchObject({
      id: 'saved',
      name: 'Field',
      character: '',
      savedAt: 0,
    });
  });

  it('rejects form revision overflow as a Promise before committing or writing', async () => {
    const save = vi.fn(async (document) => document.revision);
    const form = new CurrentForm(() => ({ selectedProfileId: null, settings: settings() }), save);
    form.restore(
      {
        version: 1,
        revision: Number.MAX_SAFE_INTEGER,
        selectedProfileId: null,
        settings: settings(),
      },
      () => {},
    );
    let failed!: Promise<unknown>;
    expect(() => {
      failed = form.flush();
    }).not.toThrow();
    await expect(failed).rejects.toThrow('Invalid current settings document.');
    await expect(form.flush()).rejects.toThrow('Invalid current settings document.');
    expect(save).not.toHaveBeenCalled();
    form.restore(
      { version: 1, revision: 3, selectedProfileId: null, settings: settings() },
      () => {},
    );
    await expect(form.flush()).resolves.toMatchObject({ revision: 4 });
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not increment an unchanged document at the maximum form revision', () => {
    const document = formDocument({
      version: 1,
      revision: Number.MAX_SAFE_INTEGER,
      selectedProfileId: 'saved',
      settings: settings(),
    });
    const content = JSON.stringify({ ...document, revision: 0 });
    expect(nextFormSave(document, document.revision, content).revision).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => nextFormSave(document, document.revision, null)).toThrow('Invalid revision');
    expect(() => formDocument({ ...document, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      'Invalid current settings document.',
    );
  });

  it('admits existing weak login credentials and clears the mutable owner after a failed effect', async () => {
    const profile = {
      username: ' x\u0000' + 'u'.repeat(100),
      password: 'synthetic',
      characterSlot: 2,
    };
    expect(validateLoginProfile(profile)).toEqual({ username: profile.username, characterSlot: 2 });
    for (const slot of [-1, 0.5, 3, '1'])
      expect(() => characterSlot(slot)).toThrow('Invalid login settings.');
    const calls: string[] = [],
      controller = new LoginController(
        {
          prepare: async (draft) => {
            calls.push(draft.password);
            throw new Error('Unavailable');
          },
          submit: () => {
            calls.push('submit');
          },
          selectionReady: () => false,
          select: () => false,
        },
        () => 100,
      );
    await controller.start(profile);
    expect(calls).toEqual(['synthetic']);
    expect(profile.password).toBe('');
    expect(controller.status.phase).toBe('failed');
  });

  it('preserves permissive game sessions and coercive continuation modes as separate contracts', () => {
    expect(gameSessionId(' ')).toBe(' ');
    expect(gameSessionId('\u0000')).toBe('\u0000');
    for (const value of ['', 'a'.repeat(65), null])
      expect(() => gameSessionId(value)).toThrow('Invalid game session ID');
    const mode = ['botOnly'],
      account = updateAccount({ username: ' synthetic ', characterSlot: 0, mode });
    expect(account.username).toBe(' synthetic ');
    expect(account.mode).toBe(mode);
    expect(JSON.parse(JSON.stringify(account)).mode).toEqual(['botOnly']);
    expect(updateRequestId('')).toBe('');
    expect(updateRequestId('custom-request')).toBe('custom-request');
    expect(() => updateRequestId(0)).toThrow('Update handoff is unavailable.');
  });

  it('keeps invalid close events inert and preserves cancellation ordering after storage failure', async () => {
    for (const value of [
      null,
      {},
      { token: '' },
      { token: token.toUpperCase().replace('000000000001', 'ABCDEF000001') },
    ])
      expect(closeRequest(value)).toBeNull();
    const events: string[] = [],
      close = new SettingsClose({
        settled: async () => {
          events.push('settled');
        },
        flush: async () => {
          events.push('flush');
          throw new Error('quota');
        },
        unchanged: () => true,
        complete: async () => {
          events.push('complete');
        },
        cancel: async (received) => {
          expect(received).toBe(token);
          events.push('cancel');
        },
        lock: (value) => {
          events.push(`lock:${value}`);
        },
        status: () => {
          events.push('status');
        },
      });
    await close.request({ token: 'invalid' });
    expect(events).toEqual([]);
    await close.request({ token });
    expect(events).toEqual([
      'lock:true',
      'status',
      'settled',
      'flush',
      'cancel',
      'status',
      'lock:false',
    ]);
  });

  it('admits detached saved services without confusing registry and contract identity', () => {
    const input = structuredClone(BUILTIN_SERVICES[0]!),
      expected = structuredClone(input),
      saved = checkedSavedService(input);
    input.identity.name = 'Changed';
    input.workflow.steps.length = 0;
    expect(JSON.parse(JSON.stringify(saved))).toEqual(expected);
    expect(savedServiceId('saved_service-1')).toBe('saved_service-1');
    expect(serviceContractId(' contract:storage visit ')).toBe(' contract:storage visit ');
    expect(() => savedServiceId('bad service')).toThrow('Invalid service identifier.');
    expect(() => savedServiceId(' ')).toThrow('Invalid service text.');
    expect(() => serviceContractId('a'.repeat(129))).toThrow('Invalid service text.');
  });

  it('keeps the legacy absent workflow timeout at the same persistence failure seam', () => {
    const definition = structuredClone(BUILTIN_SERVICES[0]!);
    const input = { ...definition, workflow: { ...definition.workflow, timeoutMs: undefined } };
    expect(checkedSavedService(input).workflow.timeoutMs).toBeUndefined();
    const write = vi.fn(),
      id = vi.fn(() => 'saved');
    const store = new NpcServiceStore({ getItem: () => null, setItem: write }, id);
    expect(() => store.save(input)).toThrow('Invalid service fields.');
    expect(id).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it('uses distinct identities and units and exposes readonly admitted models', () => {
    // Compile-only contracts must not execute invalid operations.
    if (false) {
      const document = formDocument({
        version: 1,
        revision: 0,
        selectedProfileId: null,
        settings: settings(),
      });
      // @ts-expect-error inventory revisions cannot confirm a form save
      nextFormSave(document, revisionFor('inventory', 0), null);
      // @ts-expect-error seconds cannot be used as a millisecond readiness clock
      selectionReadiness(true, null, seconds(1));
      // @ts-expect-error skill IDs are not character slots
      loginPacketStatus({ phase: 'signingIn', message: '' }, Uint8Array.of(0), skillId(1));
      // @ts-expect-error admitted form settings are readonly
      document.settings.targets.push(4000);
      // @ts-expect-error admitted form revisions are readonly
      document.revision = formRevision(1);
      // @ts-expect-error a close capability is not an update correlation ID
      const request: UpdateRequestId = closeRequest({ token })!.token;
      // @ts-expect-error an update correlation ID cannot close settings
      const close: CloseToken = updateRequestId('update');
      // @ts-expect-error session identity uses its own permissive policy, not UUID world identity
      const session: GameSessionId = worldId(token);
      // @ts-expect-error profile identity is not an update request
      const profile: ProfileId = updateRequestId('saved');
      // @ts-expect-error profile names are not profile identities
      const name: ProfileName = profileId('saved');
      // @ts-expect-error saved timestamps are not millisecond durations
      const savedAt: ProfileSavedAt = milliseconds(1);
      // @ts-expect-error unscoped revisions are not form revisions
      const revision: FormRevision = revisionFor('unscoped', 0);
      const catalog = parseMapCatalog({ Items: [] }, { Items: [] });
      // @ts-expect-error admitted catalogs use map codes, not profile IDs
      catalog.get(profileId('map'));
      const row = [...catalog.values()][0]!.monsters[0]!;
      // @ts-expect-error monster species IDs are not item IDs
      const item: ReturnType<typeof itemId> = row.classId;
      // @ts-expect-error actor IDs are not profile timestamps
      const timestamp: ProfileSavedAt = actorId(0);
      const service = checkedSavedService(BUILTIN_SERVICES[0]!);
      // @ts-expect-error a saved registry ID cannot identify a pinned contract
      const contract: ServiceContractId = service.id;
      // @ts-expect-error service registry IDs are not profile IDs
      const serviceProfile: ProfileId = service.id;
      // @ts-expect-error saved service workflows are readonly
      service.workflow.steps.push({ type: 'advance' });
      const stock = recoveryInventory({ inventoryKnown: true, inventory: [] });
      // @ts-expect-error recovery projections select item IDs, not inventory slot IDs
      carriedRecoveryItem(stock)(bagId(501));
      // @ts-expect-error a validated UI actor cannot select a recovery item
      carriedRecoveryItem(stock)(actorInput('501')!);
      void [
        request,
        close,
        session,
        profile,
        name,
        savedAt,
        revision,
        item,
        timestamp,
        contract,
        serviceProfile,
      ];
    }
  });
});
