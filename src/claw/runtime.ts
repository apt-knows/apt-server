import type { AgentRuntime, AgentRuntimeEvent, AgentSubmitOptions } from '../agent-runtime.js';
import type { AgentInstance } from '../domain.js';
import { ClawMaterializer } from './materializer.js';
import type { ClawRunContext, ClawService } from './service.js';

export class ClawAgentRuntime implements AgentRuntime {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly inner: AgentRuntime,
    private readonly service: ClawService,
    private readonly materializer: ClawMaterializer,
  ) {}

  async submit(instance: AgentInstance, input: string, options?: AgentSubmitOptions) {
    const context = options?.clawContext;
    if (!context) throw new Error('Claw runtime requires a server-owned run context.');
    return this.withProfileLock(instance.hermesProfileName, async () => {
      const runtimeArtifacts = await this.materializer.readCompletedPrivateArtifacts(instance);
      if (runtimeArtifacts) await this.service.reconcileRuntime(context.userId, runtimeArtifacts);
      const prepared = await this.service.prepareTurn(context, instance, input);
      await this.materializer.materialize(instance, prepared.bundle, prepared.runtimeHash);
      await this.service.markMaterialized(context.userId, prepared.runtimeHash);
      return this.inner.submit(instance, input, {
        ...options,
        instructions: prepared.instructions,
        conversationHistory: prepared.bundle.conversationHistory,
      });
    });
  }

  async reconcile(instance: AgentInstance, context?: ClawRunContext) {
    if (!context) return;
    await this.withProfileLock(instance.hermesProfileName, async () => {
      const artifacts = await this.materializer.readCompletedPrivateArtifacts(instance);
      if (artifacts) await this.service.reconcileRuntime(context.userId, artifacts);
    });
  }

  getState(instance: AgentInstance, runId: string) { return this.inner.getState(instance, runId); }
  stream(instance: AgentInstance, runId: string): AsyncIterable<AgentRuntimeEvent> { return this.inner.stream(instance, runId); }
  stop(instance: AgentInstance, runId: string) { return this.inner.stop(instance, runId); }
  health() { return this.inner.health(); }

  private async withProfileLock<T>(profileName: string, operation: () => Promise<T>) {
    const previous = this.locks.get(profileName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(profileName, chained);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.locks.get(profileName) === chained) this.locks.delete(profileName);
    }
  }
}
