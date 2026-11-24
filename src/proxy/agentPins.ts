/**
 * Opt-in agent pins for the local proxy.
 *
 * A pins file maps a role slug (for example "reviewer") to the model that should serve that
 * role and to the number of prompt tokens the client should treat as already spent (the
 * context headroom). A request asks for a pinned turn by carrying the exact line
 * "Agent-Pin: reviewer" inside a text part of its systemInstruction; text that belongs to the
 * user is never read here.
 *
 * Failure policy: a pins file the operator configured but that cannot be read or validated is
 * rejected by throwing, and the message names only the reason and the file path — never the
 * content, because pin files sit next to saved provider keys and error text reaches the logs.
 * Ambiguous requests (repeated or competing markers) are rejected before any provider call.
 */
import * as fs from 'fs';

export type AgentPin = { model: string; contextReserve: number };

export interface TokenUsage {
  promptTokenCount: number;
  totalTokenCount: number;
  candidatesTokenCount: number;
}

/** Role names are slugs: lowercase letters and digits joined by single hyphens. */
const ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Model identifiers are single printable tokens such as "models/local-reviewer". */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** The marker is its own complete line inside a text part: "Agent-Pin: <role>". */
const MARKER_PATTERN = /^Agent-Pin: (\S+)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads the pins file. Without a file argument (or with an empty one) the feature is off and an
 * empty map keeps every request on its normal route. A configured file that is unreadable or
 * malformed throws an error whose message contains no file content; only role names, which the
 * slug pattern has already sanitised, appear in it.
 */
export function loadAgentPins(file?: string): ReadonlyMap<string, AgentPin> {
  const pins = new Map<string, AgentPin>();
  if (!file) return pins;

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(`agentPins: cannot read the pins file (${file})`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`agentPins: the pins file is not valid JSON (${file})`);
  }
  if (!isPlainObject(data)) {
    throw new Error(`agentPins: the pins file must hold one object mapping role names to pins (${file})`);
  }

  for (const [role, entry] of Object.entries(data)) {
    if (!ROLE_PATTERN.test(role)) {
      throw new Error(`agentPins: a role name in the pins file is not a lowercase slug (${file})`);
    }
    if (!isPlainObject(entry)) {
      throw new Error(`agentPins: the "${role}" entry in the pins file is not an object (${file})`);
    }
    for (const field of Object.keys(entry)) {
      if (field !== 'model' && field !== 'contextReserve') {
        throw new Error(`agentPins: the "${role}" entry in the pins file has an unexpected field (${file})`);
      }
    }
    const model = entry.model;
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
      throw new Error(`agentPins: the "${role}" entry in the pins file has no usable model (${file})`);
    }
    let contextReserve = 0;
    if (entry.contextReserve !== undefined) {
      if (!isSafeCount(entry.contextReserve)) {
        throw new Error(`agentPins: the "${role}" entry in the pins file has an invalid contextReserve (${file})`);
      }
      contextReserve = entry.contextReserve;
    }
    pins.set(role, { model, contextReserve });
  }
  return pins;
}

/** Collects marker roles, scanning text parts of a system instruction only. */
function markerRoles(instruction: unknown): string[] {
  if (!isPlainObject(instruction)) return [];
  // A whole request body may arrive by mistake: only its system instruction may be scanned.
  if (Array.isArray(instruction.contents)) return markerRoles(instruction.systemInstruction);
  // The caller passes the systemInstruction field, not a message from contents.
  // Signed-in AGY labels that field itself with role: "user".
  if (!Array.isArray(instruction.parts)) return [];

  const roles: string[] = [];
  for (const part of instruction.parts) {
    if (!isPlainObject(part) || typeof part.text !== 'string') continue;
    for (const line of part.text.split(/\r?\n/)) {
      const marker = MARKER_PATTERN.exec(line);
      if (marker) roles.push(marker[1]);
    }
  }
  return roles;
}

/**
 * Resolves the pin a request asks for. Without a marker, or when the named role is not
 * configured, the request stays unpinned. Repeated or competing markers are refused, never
 * guessed.
 */
export function selectAgentPin(pins: ReadonlyMap<string, AgentPin>, instruction: unknown): AgentPin | undefined {
  const roles = markerRoles(instruction);
  if (roles.length > 1) throw new Error('Ambiguous agent pin markers.');
  if (!roles.length) return undefined;
  return pins.get(roles[0]);
}

/**
 * Moves the pin's reserve into reported usage so the client budgets context as if that many
 * prompt tokens were already spent: prompt and total grow, the output counter never changes.
 * When a counter is missing or otherwise untrustworthy, or an adjusted counter would leave the
 * safe integer range, every counter is left exactly as the provider reported it — nothing is
 * synthesized. A zero (or invalid) reserve changes nothing.
 */
export function applyContextReserve(usage: TokenUsage, reserve: number): void {
  if (!isSafeCount(reserve) || reserve === 0) return;
  if (!usage) return;
  const { promptTokenCount, totalTokenCount, candidatesTokenCount } = usage;
  if (!isSafeCount(promptTokenCount) || !isSafeCount(totalTokenCount) || !isSafeCount(candidatesTokenCount)) return;
  if (!promptTokenCount || totalTokenCount < promptTokenCount || totalTokenCount < candidatesTokenCount) return;
  const prompt = promptTokenCount + reserve;
  const total = totalTokenCount + reserve;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(total)) return;
  usage.promptTokenCount = prompt;
  usage.totalTokenCount = total;
}
