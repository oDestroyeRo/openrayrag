import { mcpWriteTool, type McpQuery, type McpWriteTool } from './mcp-logic';
export const MCP_CLIENT_ACTIONS = [
  'command',
  'workflow',
  'routine',
  'macro',
  'service',
  'social',
  'memo',
  'socketPreview',
  'socket',
  'warpPreview',
  'warp',
  'warpCancel',
  'refinePreview',
  'refine',
  'refineAdvance',
] as const;
const fields: Record<McpWriteTool, readonly string[]> = {
  set_settings: ['expectedDraftRevision', 'settings'],
  set_script: ['expectedDraftRevision', 'script'],
  profile: ['expectedDraftRevision', 'operation', 'id', 'name', 'document'],
  service_definition: ['expectedDraftRevision', 'operation', 'id', 'definition', 'document'],
  connect: [
    'expectedDraftRevision',
    'username',
    'password',
    'characterSlot',
    'mode',
    'remember',
    'autoLogin',
  ],
  disconnect: ['expectedGeneration'],
  start_bot: ['expectedDraftRevision', 'expectedGeneration'],
  stop_bot: [],
  apply_settings: ['expectedDraftRevision', 'expectedGeneration'],
  set_reconnect: ['expectedDraftRevision', 'enabled'],
  forget_login: ['expectedDraftRevision'],
  client_action: ['expectedGeneration', 'action', 'request'],
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Envelope checks precede effects; settings and gameplay keep their existing deep admission owners. */
export function mcpWriteArguments(query: McpQuery): void {
  if (!mcpWriteTool(query.tool)) throw new Error('Unknown control tool.');
  const args = query.arguments,
    allowed = fields[query.tool];
  if (
    !record(args) ||
    Object.keys(args).some((key) => key !== 'requestId' && !allowed.includes(key)) ||
    typeof args.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(args.requestId)
  )
    throw new Error('Invalid control arguments.');
  for (const key of ['expectedDraftRevision', 'expectedGeneration'])
    if (allowed.includes(key) && !revision(args[key]))
      throw new Error('Invalid expected revision.');
  if (query.tool === 'set_settings' && !record(args.settings)) throw new Error('Invalid settings.');
  if (query.tool === 'set_script' && typeof args.script !== 'string')
    throw new Error('Invalid script.');
  if (query.tool === 'set_reconnect' && typeof args.enabled !== 'boolean')
    throw new Error('Invalid preference.');
  if (query.tool === 'profile' || query.tool === 'service_definition') {
    const operations =
      query.tool === 'profile'
        ? ['save', 'remove', 'import', 'apply', 'select']
        : ['save', 'remove', 'import'];
    if (typeof args.operation !== 'string' || !operations.includes(args.operation))
      throw new Error('Invalid store operation.');
    if (args.id !== undefined && (typeof args.id !== 'string' || !args.id || args.id.length > 128))
      throw new Error('Invalid store ID.');
    if (args.operation === 'import' && typeof args.document !== 'string')
      throw new Error('Missing document.');
    if (['remove', 'apply', 'select'].includes(args.operation) && typeof args.id !== 'string')
      throw new Error('Missing store ID.');
    if (
      args.operation === 'save' &&
      (query.tool === 'profile' ? typeof args.name !== 'string' : !record(args.definition))
    )
      throw new Error('Invalid store value.');
  }
  if (query.tool === 'connect') {
    if (Object.hasOwn(args, 'username') !== Object.hasOwn(args, 'password'))
      throw new Error('Supply both credential fields or omit both.');
    for (const key of ['username', 'password'])
      if (args[key] !== undefined && typeof args[key] !== 'string')
        throw new Error('Invalid credentials.');
    for (const key of ['remember', 'autoLogin'])
      if (args[key] !== undefined && typeof args[key] !== 'boolean')
        throw new Error('Invalid preference.');
    if (
      args.characterSlot !== undefined &&
      (!revision(args.characterSlot) || Number(args.characterSlot) > 2)
    )
      throw new Error('Invalid character slot.');
    if (args.mode !== undefined && args.mode !== 'botOnly' && args.mode !== 'gameClient')
      throw new Error('Invalid connection mode.');
  }
  if (
    query.tool === 'client_action' &&
    (typeof args.action !== 'string' ||
      !MCP_CLIENT_ACTIONS.some((action) => action === args.action) ||
      !record(args.request))
  )
    throw new Error('Invalid action envelope.');
}
