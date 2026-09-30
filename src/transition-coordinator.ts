import type { Model, Tool } from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getCodexAccountFingerprint } from "./codex-wire.js";
import {
  applyRemoteCompactionMarker, buildFallbackSummary, createTransitionCheckpoint,
  findActiveRemoteCompaction, getCodexAuthKind, isRemoteCompactionCompatible,
  REMOTE_SUMMARY_MARKER, supportsRemoteCompaction, type RemoteCompactionDetails,
} from "./remote-compaction.js";
import { identity, latestTransition, parseTransition, TRANSITION_ENTRY, type TransitionRecord } from "./transition-state.js";

type Messages = ReturnType<typeof sessionEntryToContextMessages>;
/** Pi's context hook does not expose its system-message domain to extensions.
 * Keep this helper aligned with runner.emitContext(), while retaining an exact
 * comparison of every conversation message that the handler can see. */
function visibleContextMessages(entries: readonly SessionEntry[]): Messages {
  return entries.flatMap(sessionEntryToContextMessages)
    .filter(message => (message.role as string) !== "system");
}
type Pending = {
  record: TransitionRecord; model: Model<any>; details: RemoteCompactionDetails;
  generation: number; selectionLeaf: string; controller: AbortController;
};
type Activation = {
  generation: number; session: string; fingerprint: string; transition: string;
  model: string; authKind: string; registry: ExtensionContext["modelRegistry"];
};

/** Do not compact a broken or unfinished tool exchange. The provider serializer
 * may otherwise repair it silently, which is not a safe transition boundary. */
export function hasCompleteToolHistory(messages: Messages): boolean {
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (outstanding.size) return false;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (outstanding.has(block.id)) return false;
        outstanding.add(block.id);
      }
    } else if (message.role === "toolResult") {
      if (!outstanding.delete(message.toolCallId)) return false;
    } else if (message.role === "user" && outstanding.size) {
      return false;
    }
  }
  return outstanding.size === 0;
}
export class TransitionCoordinator {
  private generation = 0;
  private pending?: Pending;
  private inFlight?: Pending;
  private running?: Promise<Activation | undefined>;
  private request?: { record: TransitionRecord; activation: Activation };
  constructor(
    private append: (type: string, data: unknown) => void,
    private tools: (model: Model<any>) => readonly Tool[],
    private thinking: () => string | undefined,
    private transform: (payload: Record<string, unknown>, ctx: ExtensionContext, messages: Messages) => Record<string, unknown>,
    private compact = createTransitionCheckpoint,
  ) {}

  private write(record: TransitionRecord): boolean {
    try { this.append(TRANSITION_ENTRY, record); return true; } catch { return false; }
  }
  invalidate(): void {
    this.generation++;
    if (this.pending) {
      this.pending.controller.abort();
      this.write({ ...this.pending.record, status: "FALLBACK" });
    }
    if (this.inFlight) {
      this.inFlight.controller.abort();
      this.write({ ...this.inFlight.record, status: "FALLBACK" });
    }
    this.pending = undefined;
    this.request = undefined;
  }
  private branch(ctx: ExtensionContext): SessionEntry[] {
    return ctx.sessionManager.getBranch() as SessionEntry[];
  }
  /** Capture values, not mutable model/record references. Transition identity
   * includes the checkpoint and its endpoint/account/auth scope. */
  private activation(ctx: ExtensionContext): Activation {
    const session = ctx.sessionManager.getSessionId();
    const branch = this.branch(ctx);
    return {
      generation: this.generation, session,
      fingerprint: identity(branch.filter(e => e.type !== "custom")),
      transition: identity(latestTransition(branch, session) ?? null),
      model: identity(ctx.model ?? null),
      authKind: ctx.model ? getCodexAuthKind(ctx.modelRegistry, ctx.model) : "unknown",
      registry: ctx.modelRegistry,
    };
  }
  private current(ctx: ExtensionContext, captured: Activation, checkTransition = true): boolean {
    const now = this.activation(ctx);
    return captured.generation === now.generation && captured.session === now.session &&
      captured.fingerprint === now.fingerprint && captured.model === now.model &&
      captured.authKind === now.authKind && captured.registry === now.registry &&
      (!checkTransition || captured.transition === now.transition) && !ctx.signal?.aborted;
  }
  private baseline(ctx: ExtensionContext) {
    const branch = this.branch(ctx);
    const root = [...branch].reverse().find(e => e.type === "compaction");
    if (!root || root.type !== "compaction") return undefined;
    const record = latestTransition(branch, ctx.sessionManager.getSessionId());
    if (record) {
      if (record.status !== "TRANSITIONED") return undefined;
      return { root: root.id, source: record.key, details: record.details!, summary: record.summary!, boundary: record.boundary };
    }
    const details = findActiveRemoteCompaction([root]);
    return details ? { root: root.id, source: root.id, details, summary: root.summary, boundary: undefined } : undefined;
  }
  private async compatible(ctx: ExtensionContext, details: RemoteCompactionDetails, model: Model<any>) {
    const captured = this.activation(ctx);
    const scope = identity([details, model, getCodexAuthKind(ctx.modelRegistry, model)]);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    return !!(this.current(ctx, captured) &&
      scope === identity([details, model, getCodexAuthKind(ctx.modelRegistry, model)]) &&
      auth.ok && auth.apiKey && isRemoteCompactionCompatible(
      details, model, getCodexAccountFingerprint(auth.apiKey), getCodexAuthKind(ctx.modelRegistry, model),
    ));
  }
  async select(event: { model: Model<any>; previousModel?: Model<any>; source?: string }, ctx: ExtensionContext) {
    // Capture the old baseline before terminating a pending operation.
    const baseline = this.baseline(ctx);
    this.invalidate();
    if (event.source === "restore" || !event.previousModel ||
        event.previousModel.id === event.model.id || !supportsRemoteCompaction(event.model) ||
        !supportsRemoteCompaction(event.previousModel) || !baseline) return;
    const branch = this.branch(ctx);
    const leaf = branch.at(-1)?.id;
    if (!leaf) return;
    const record: TransitionRecord = {
      version: 1, key: identity([
        ctx.sessionManager.getSessionId(), baseline.source, event.previousModel.id,
        event.model.id, baseline.details.endpoint, baseline.details.accountFingerprint,
        baseline.details.authKind, leaf,
      ]),
      session: ctx.sessionManager.getSessionId(), root: baseline.root,
      source: baseline.source, target: event.model.id, status: "PENDING",
    };
    const generation = this.generation;
    const captured = this.activation(ctx);
    try {
      const sourceCompatible = await this.compatible(ctx, baseline.details, event.previousModel);
      if (!this.current(ctx, captured)) return;
      const targetCompatible = sourceCompatible &&
        await this.compatible(ctx, { ...baseline.details, model: event.model.id }, event.model);
      if (!this.current(ctx, captured)) return;
      if (!sourceCompatible || !targetCompatible) {
        this.write({ ...record, status: "FALLBACK" });
        return;
      }
      if (generation !== this.generation) return;
      if (!this.write(record)) return;
      this.pending = { record, model: event.previousModel, details: baseline.details,
        generation, selectionLeaf: leaf, controller: new AbortController() };
    } catch {
      if (this.current(ctx, captured)) this.write({ ...record, status: "FALLBACK" });
    }
  }

  /** Derive the virtual checkpoint tail from Pi's compaction-aware branch,
   * including kept entries which can precede the physical compaction entry. */
  private effective(ctx: ExtensionContext, record?: TransitionRecord) {
    const entries = ctx.sessionManager.buildContextEntries();
    const summary = entries.find(e => e.type === "compaction");
    if (!summary || summary.type !== "compaction") return undefined;
    const tail = entries.filter(e => e.type !== "compaction");
    let start = 0;
    if (record?.boundary) {
      const index = tail.findIndex(e => e.id === record.boundary);
      if (index < 0 && record.boundary !== summary.id) return undefined;
      start = index + 1;
    }
    return { summary, tail: tail.slice(start) };
  }
  async context(messages: Messages, ctx: ExtensionContext): Promise<Messages | undefined> {
    const entered = this.activation(ctx);
    this.request = undefined;
    if (this.running) {
      const completed = await this.running;
      if (!completed || !this.current(ctx, completed)) return undefined;
    }
    if (!this.current(ctx, entered, false)) return undefined;
    const pending = this.pending;
    if (pending) {
      this.running = this.run(pending, messages, ctx);
      try {
        const completed = await this.running;
        if (!completed || !this.current(ctx, completed)) return undefined;
      } finally { this.running = undefined; }
    }
    // Our own run changes the transition record, but must not change lifecycle,
    // session, model, or history. Do not resume in a replacement lifecycle.
    if (!this.current(ctx, entered, false)) return undefined;
    const record = latestTransition(this.branch(ctx), ctx.sessionManager.getSessionId());
    if (!record) return undefined;
    if (record.status === "PENDING" || record.status === "TRANSITIONING") {
      this.write({ ...record, status: "FALLBACK" }); return undefined;
    }
    if (record.status !== "TRANSITIONED" || !ctx.model) return undefined;
    try {
      const captured = this.activation(ctx);
      if (!await this.compatible(ctx, record.details!, ctx.model)) return undefined;
      if (!this.current(ctx, captured)) return undefined;
      const effective = this.effective(ctx, record);
      const original = visibleContextMessages(ctx.sessionManager.buildContextEntries());
      // Another extension's context edits are not silently swallowed.
      if (!effective || identity(messages) !== identity(original)) return undefined;
      const virtual = { ...effective.summary, summary: record.summary! };
      if (!this.current(ctx, captured)) return undefined;
      this.request = { record, activation: captured };
      // Replacing only the visible conversation transcript leaves Pi-owned
      // system/prompt/tool state to the runner and later provider assembly.
      return [...visibleContextMessages([virtual]), ...effective.tail.flatMap(sessionEntryToContextMessages)
        .filter(message => (message.role as string) !== "system")];
    } catch { return undefined; }
  }
  private async run(p: Pending, messages: Messages, ctx: ExtensionContext) {
    this.inFlight = p;
    this.pending = undefined; // consume once, never infer from model mismatch
    const branch = this.branch(ctx);
    const fingerprint = identity(branch.filter(e => e.type !== "custom"));
    const sourceRecord = branch
      .filter(e => e.type === "custom" && e.customType === TRANSITION_ENTRY)
      .map(e => e.type === "custom" ? parseTransition(e.data) : undefined)
      .reverse().find(r => r?.key === p.record.source && r.status === "TRANSITIONED");
    try {
      if (!ctx.model || ctx.model.id !== p.record.target ||
          p.generation !== this.generation || !branch.some(e => e.id === p.selectionLeaf)) throw new Error("stale");
      const effective = this.effective(ctx, sourceRecord);
      const original = visibleContextMessages(ctx.sessionManager.buildContextEntries());
      if (!effective || effective.summary.id !== p.record.root ||
          identity(messages) !== identity(original)) throw new Error("context changed");
      const tail = effective.tail.filter(e => sessionEntryToContextMessages(e).length > 0);
      // A transition never compacts an unfinished tool turn. The final user
      // entry remains outside the checkpoint and appears once in the request.
      const incoming = tail.at(-1);
      if (!incoming || incoming.type !== "message" || incoming.message.role !== "user") throw new Error("not a user boundary");
      const history = tail.slice(0, -1);
      const historyMessages = history.flatMap(sessionEntryToContextMessages);
      if (!hasCompleteToolHistory(historyMessages)) throw new Error("incomplete tool history");
      const boundary = history.at(-1)?.id ?? sourceRecord?.boundary;
      // Empty tails still need an anchor. Use the current root's summary anchor.
      const anchor = boundary ?? effective.summary.id;
      if (!this.write({ ...p.record, status: "TRANSITIONING" })) throw new Error("persist");
      const captured = this.activation(ctx);
      const signal = AbortSignal.any([ctx.signal ?? new AbortController().signal, p.controller.signal]);
      const details = await this.compact(
        { ...ctx, signal }, p.model, p.details, historyMessages,
        () => this.tools(p.model), this.thinking(),
        payload => this.transform(payload, { ...ctx, model: p.model }, historyMessages),
      );
      if (!this.current(ctx, captured)) return;
      if (!details || signal.aborted || p.generation !== this.generation ||
          ctx.model.id !== p.record.target ||
          fingerprint !== identity(this.branch(ctx).filter(e => e.type !== "custom"))) throw new Error("stale");
      const sourceCompatible = await this.compatible(ctx, p.details, p.model);
      if (!this.current(ctx, captured)) return;
      const targetCompatible = sourceCompatible &&
        await this.compatible(ctx, { ...details, model: p.record.target }, ctx.model);
      if (!this.current(ctx, captured)) return;
      if (!sourceCompatible || !targetCompatible || signal.aborted || p.generation !== this.generation ||
          fingerprint !== identity(this.branch(ctx).filter(e => e.type !== "custom"))) throw new Error("scope changed");
      const summary = `${REMOTE_SUMMARY_MARKER}\n\n${buildFallbackSummary({
        previousSummary: sourceRecord?.summary ?? effective.summary.summary,
        fileOps: { read: new Set(), edited: new Set() },
      } as Parameters<typeof buildFallbackSummary>[0], historyMessages)}`;
      if (!this.write({ ...p.record, status: "TRANSITIONED", boundary: anchor, summary,
        details: { ...details, model: p.record.target } })) throw new Error("persist");
      // Waiting context callbacks may accept only this exact completion, not
      // a different checkpoint which superseded it while they were suspended.
      return this.activation(ctx);
    } catch {
      // Never append into a different session/branch after navigation.
      if (latestTransition(this.branch(ctx), p.record.session)?.key === p.record.key &&
          ctx.sessionManager.getSessionId() === p.record.session &&
          this.branch(ctx).some(e => e.id === p.record.root)) {
        this.write({ ...p.record, status: "FALLBACK" });
      }
    } finally {
      if (this.inFlight === p) this.inFlight = undefined;
    }
  }
  async requestPayload(payload: unknown, ctx: ExtensionContext): Promise<unknown | undefined> {
    const request = this.request;
    this.request = undefined;
    if (!request || !ctx.model ||
        !this.current(ctx, request.activation)) return undefined;
    try {
      if (!await this.compatible(ctx, request.record.details!, ctx.model)) return undefined;
      if (!this.current(ctx, request.activation)) return undefined;
      return applyRemoteCompactionMarker(payload, request.record.details!);
    } catch { return undefined; }
  }
}
