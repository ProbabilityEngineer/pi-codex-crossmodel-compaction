import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRemoteCompactionDetails, type RemoteCompactionDetails } from "./remote-compaction.js";

export const TRANSITION_ENTRY = "pi-codex-compaction:transition:v1";
export type TransitionStatus = "PENDING" | "TRANSITIONING" | "TRANSITIONED" | "FALLBACK";
export interface TransitionRecord {
  version: 1;
  key: string;
  session: string;
  root: string;
  source: string;
  target: string;
  status: TransitionStatus;
  boundary?: string;
  summary?: string;
  details?: RemoteCompactionDetails;
}

export function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseTransition(value: unknown): TransitionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as TransitionRecord;
  if (v.version !== 1 || !/^[a-f0-9]{64}$/.test(v.key) ||
      ![v.session, v.root, v.source, v.target].every(x => typeof x === "string" && x.length > 0 && x.length < 512) ||
      !["PENDING", "TRANSITIONING", "TRANSITIONED", "FALLBACK"].includes(v.status)) return undefined;
  if (v.status === "TRANSITIONED" && (
    typeof v.boundary !== "string" || typeof v.summary !== "string" || v.summary.length > 13_000 ||
    !isRemoteCompactionDetails(v.details) || v.details.model !== v.target
  )) return undefined;
  return v;
}

/** Only records on the current branch, tied to its latest Pi compaction. */
export function latestTransition(branch: readonly SessionEntry[], session: string): TransitionRecord | undefined {
  const root = [...branch].reverse().find(e => e.type === "compaction")?.id;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type !== "custom" || e.customType !== TRANSITION_ENTRY) continue;
    const record = parseTransition(e.data);
    if (record?.session === session && record.root === root) return record;
  }
  return undefined;
}
