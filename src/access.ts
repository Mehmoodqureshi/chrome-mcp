/** Email-link access gate for the MCP tool surface. */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

type AccessState = { deviceId: string; deviceSecret: string; challengeId?: string; verified?: boolean };
const SITE = (process.env.CHROME_MCP_ACCESS_API ?? 'https://mcp-browser-extension.com/api/access').replace(/\/$/, '');
let accessPollMs = 2_000;
const EMAIL_SCHEMA = {
  type: 'object' as const,
  properties: { email: { type: 'string' as const, title: 'Email address', description: 'The address where you want to receive the verification link.' } },
  required: ['email'],
};
let validUntil = 0;
let currentCheck: Promise<string | null> | undefined;
const pollingChallenges = new Set<string>();

/** @internal Test seam for the verification watcher. */
export function setAccessPollIntervalForTesting(ms: number): void {
  accessPollMs = Math.max(1, ms);
}

function statePath(dataDir: string): string { return join(dataDir, 'access.json'); }

function loadOrCreate(dataDir: string): AccessState {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as Partial<AccessState>;
    if (/^[a-f0-9]{32}$/.test(parsed.deviceId ?? '') && /^[A-Za-z0-9_-]{42,50}$/.test(parsed.deviceSecret ?? '')) {
      return parsed as AccessState;
    }
  } catch { /* create a new local identity */ }
  const state = { deviceId: randomBytes(16).toString('hex'), deviceSecret: randomBytes(32).toString('base64url') };
  saveState(dataDir, state);
  return state;
}

function saveState(dataDir: string, state: AccessState): void {
  const path = statePath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function watchForEmailApproval(dataDir: string, challengeId: string, delayMs = accessPollMs): void {
  if (pollingChallenges.has(challengeId)) return;
  pollingChallenges.add(challengeId);
  const timer = setTimeout(() => {
    void (async () => {
      let retry = true;
      try {
        const state = loadOrCreate(dataDir);
        if (state.verified || state.challengeId !== challengeId) {
          retry = false;
        } else {
          const status = await api('status', { challengeId });
          if (status.ok && status.data.status === 'approved') {
            const validated = await api('validate', { deviceId: state.deviceId, deviceSecret: state.deviceSecret });
            if (validated.ok && validated.data.authorized === true) {
              state.verified = true;
              delete state.challengeId;
              saveState(dataDir, state);
              validUntil = Date.now() + 60_000;
              retry = false;
            } else if (validated.status === 403) {
              delete state.challengeId;
              saveState(dataDir, state);
              retry = false;
            }
          }
          if (!status.ok && status.status === 410) {
            delete state.challengeId;
            saveState(dataDir, state);
            retry = false;
          }
        }
      } catch { /* retry while this MCP server remains running */ }
      pollingChallenges.delete(challengeId);
      if (retry) watchForEmailApproval(dataDir, challengeId, Math.min(delayMs * 2, 30_000));
    })();
  }, delayMs);
  timer.unref();
}

async function api(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${SITE}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  let data: Record<string, unknown> = {};
  try { const value: unknown = await response.json(); if (value && typeof value === 'object') data = value as Record<string, unknown>; } catch { /* handled as service failure */ }
  return { ok: response.ok, status: response.status, data };
}

function result(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Returns null when authorized, otherwise a user-facing tool error. */
export async function requireAccess(server: Server, dataDir: string): Promise<ReturnType<typeof result> | null> {
  if (Date.now() < validUntil) return null;
  if (currentCheck) return result((await currentCheck) ?? 'Access verification complete. Retry the browser tool.');
  currentCheck = check(server, dataDir).finally(() => { currentCheck = undefined; });
  const message = await currentCheck;
  return message ? result(message) : null;
}

async function check(server: Server, dataDir: string): Promise<string | null> {
  const state = loadOrCreate(dataDir);
  try {
    if (state.verified) {
      const revalidated = await api('validate', { deviceId: state.deviceId, deviceSecret: state.deviceSecret });
      if (revalidated.ok && revalidated.data.authorized === true) {
        validUntil = Date.now() + 60_000;
        return null;
      }
      if (revalidated.status === 403) {
        state.verified = false;
        delete state.challengeId;
        saveState(dataDir, state);
        return 'Access was revoked or needs verification again. Retry the browser tool to verify your email.';
      }
      return 'Access could not be checked right now. Retry the browser tool shortly.';
    }
    if (!state.challengeId) {
      let elicitation;
      try {
        elicitation = await server.elicitInput({
          mode: 'form',
          message: 'Enter your email to receive a one-time sign-in link for MCP Browser Extension. The email is used to verify and manage access.',
          requestedSchema: EMAIL_SCHEMA,
        });
      } catch {
        return 'Your MCP client did not display the email prompt. This access flow requires an MCP client that supports elicitation. Enable elicitation or connect from a supported client, then retry.';
      }
      if (elicitation.action !== 'accept' || typeof elicitation.content?.email !== 'string') return 'Email verification was not completed. Retry the browser tool to start again.';
      const email = elicitation.content.email.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That email address is invalid. Retry the browser tool and enter a valid address.';
      state.challengeId = randomBytes(32).toString('hex');
      saveState(dataDir, state);
      const started = await api('start', { email, challengeId: state.challengeId, deviceId: state.deviceId, deviceSecret: state.deviceSecret });
      if (!started.ok) {
        delete state.challengeId;
        saveState(dataDir, state);
        const message = typeof started.data.error === 'string' ? started.data.error : 'The verification email could not be sent. Check your connection and retry the browser tool.';
        return message;
      }
      watchForEmailApproval(dataDir, state.challengeId);
      return 'A sign-in link has been sent to your email. Open it in a browser. Verification will sync to this server automatically; then click Connect in the extension and retry the browser tool.';
    }

    const status = await api('status', { challengeId: state.challengeId });
    if (!status.ok && status.status === 410) {
      delete state.challengeId;
      saveState(dataDir, state);
      return 'Your email link expired. Retry the browser tool to request a fresh link.';
    }
    if (!status.ok) {
      watchForEmailApproval(dataDir, state.challengeId);
      return 'Email verification could not be checked right now. Retry the browser tool shortly.';
    }
    if (status.data.status !== 'approved') {
      watchForEmailApproval(dataDir, state.challengeId);
      return 'Open the sign-in link sent to your email. The server will finish activation automatically; then click Connect in the extension and retry the browser tool.';
    }

    const validated = await api('validate', { deviceId: state.deviceId, deviceSecret: state.deviceSecret });
    if (!validated.ok || validated.data.authorized !== true) {
      if (validated.status === 403) {
        delete state.challengeId;
        saveState(dataDir, state);
        return 'Access was revoked or could not be verified. Retry the browser tool to request a new email link.';
      }
      return 'Access could not be confirmed. Retry the browser tool, or request a new email link if needed.';
    }
    state.verified = true;
    delete state.challengeId;
    saveState(dataDir, state);
    validUntil = Date.now() + 60_000;
    return null;
  } catch {
    return 'Access verification is temporarily unavailable. Check your connection and retry the browser tool.';
  }
}
