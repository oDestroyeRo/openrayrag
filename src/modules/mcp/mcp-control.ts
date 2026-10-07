import {
  mcpObservation,
  mcpWriteTool,
  type McpQuery,
  type McpReadContext,
  type McpWriteTool,
} from './mcp-logic';
import { mcpWriteArguments } from './mcp-control-logic';

export interface McpControlAdapter {
  claim(query: McpQuery): Promise<void>;
  read(query: McpQuery): McpReadContext;
  perform(
    tool: McpWriteTool,
    arguments_: Record<string, unknown>,
    operation: string,
  ): Promise<Record<string, unknown>>;
}

/** One ordinary writer, no queued writes. Stop can overtake a claimed activation. */
export class McpControl {
  private writing = false;
  private stopEpoch = 0;
  // Native-only CI admission starts without a UI lifecycle transition. Native
  // authorization is still mandatory; an explicit local revoke closes this gate.
  private grantRevoked = false;
  private grantEpoch = 0;
  constructor(private readonly adapter: McpControlAdapter) {}
  get busy(): boolean {
    return this.writing;
  }
  /** Shared by local and assistant Stop before asynchronous cancellation begins. */
  retireActivations(): void {
    this.stopEpoch++;
  }
  revoke(): void {
    this.grantRevoked = true;
    this.grantEpoch++;
  }
  renew(): void {
    this.grantRevoked = false;
    this.grantEpoch++;
  }
  async execute(query: McpQuery): Promise<Record<string, unknown>> {
    if (!mcpWriteTool(query.tool)) return { error: 'Unknown control operation.' };
    const stop = query.tool === 'stop_bot';
    const competing = !stop && this.writing;
    let reserved = false;
    try {
      if (!stop && !competing) {
        this.writing = true;
        reserved = true;
      }
      const epoch = this.stopEpoch;
      const grant = this.grantEpoch;
      // Native checks current grant, request lifetime, generation and duplicate claim.
      await this.adapter.claim(query);
      if (this.grantRevoked || grant !== this.grantEpoch)
        return { error: 'Bot controls were revoked. Enable a new control grant before retrying.' };
      mcpWriteArguments(query);
      if (competing)
        return {
          error: 'Another assistant operation is in progress. Read the current state and retry.',
        };
      if (stop) this.retireActivations();
      else {
        if (epoch !== this.stopEpoch)
          return { error: 'Operation cancelled by Stop before dispatch.' };
        const context = this.adapter.read(query);
        if (context.controls?.busy || context.updateBusy)
          return { error: 'The client is busy. Read the current state and retry.' };
        if (
          'expectedDraftRevision' in query.arguments &&
          query.arguments.expectedDraftRevision !== context.draftRevision
        )
          return { error: 'The editable draft changed. Read the current draft before retrying.' };
        if ('expectedGeneration' in query.arguments) {
          if (query.arguments.expectedGeneration !== query.runtimeGeneration)
            return {
              error: 'The game connection was replaced. Read the current state before retrying.',
            };
          if (mcpObservation(context).state !== 'current')
            return { error: 'A fresh, verified game observation is required.' };
        }
      }
      return await this.adapter.perform(query.tool, query.arguments, query.id);
    } catch {
      // Native/parser errors may contain supplied account values. Never mirror them to MCP.
      return {
        error:
          'The operation was rejected or could not complete. Read the current state and operation outcome before retrying.',
      };
    } finally {
      if (reserved) this.writing = false;
    }
  }
}
