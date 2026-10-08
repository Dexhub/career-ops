// Per-agent kill switches, shared by Mission Control and the running cycle.
//
// Same IPC pattern as the pause flag: a file's presence means "this agent is
// stopped". The cycle reads the flag fresh at every decision point, so a
// toggle from the panel takes effect at the next stage boundary (scan/rank)
// or before the next pick (apply) — in-flight work is never killed. The
// whole-cycle Stop button remains the hard kill.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

export const AGENTS = Object.freeze(['scan', 'rank', 'apply']);

function flagPath(agent) {
  return join(getCareerOpsRoot(), 'data', 'auto', 'agents', `${agent}.stopped`);
}

/** @returns {boolean} true unless the agent's stop flag exists */
export function agentEnabled(agent) {
  return !existsSync(flagPath(agent));
}

export function setAgentEnabled(agent, enabled) {
  if (!AGENTS.includes(agent)) return { ok: false, error: `unknown agent "${agent}" — use ${AGENTS.join('/')}` };
  const p = flagPath(agent);
  if (enabled) rmSync(p, { force: true });
  else {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, new Date().toISOString(), 'utf8');
  }
  return { ok: true, agent, enabled };
}

/** @returns {{scan: boolean, rank: boolean, apply: boolean}} */
export function agentFlags() {
  return Object.fromEntries(AGENTS.map((a) => [a, agentEnabled(a)]));
}
