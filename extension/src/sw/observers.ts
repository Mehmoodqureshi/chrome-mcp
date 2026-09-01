/**
 * extension/src/sw/observers.ts — registers (and unregisters) the MAIN-world
 * observer hook as a document_start content script.
 *
 * Why register rather than inject on demand: the interesting console output and
 * the interesting failed request both happen while the page loads. A hook
 * injected when the tool is first called has already missed them, and telling a
 * user "reload and try again" is a worse answer than being there from the start.
 *
 * Registration is driven entirely by the policy the server delivers: it happens
 * only when `allowObservers` is on, and only for the domains on the allowlist —
 * so a page the tool may not read is also a page the tool does not instrument.
 */

import { observerMatches } from '../../../shared/observers';
import type { WirePolicy } from '../../../shared/protocol';

const SCRIPT_ID = 'chrome-mcp-observers';

/** Bring the registered script in line with `policy`; never throws. */
export async function syncObserverScript(policy: WirePolicy | null, log: (m: string) => void): Promise<void> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
    const wanted = policy ? observerMatches(policy) : [];

    if (wanted.length === 0) {
      if (existing.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
        log('observers: unregistered (disabled by policy)');
      }
      return;
    }

    const spec: chrome.scripting.RegisteredContentScript = {
      id: SCRIPT_ID,
      js: ['page-hook.js'],
      matches: wanted,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: false,
    };
    if (existing.length > 0) await chrome.scripting.updateContentScripts([spec]);
    else await chrome.scripting.registerContentScripts([spec]);
    log(`observers: registered for ${wanted.join(', ')}`);
  } catch (err) {
    // A failed registration is not fatal: the `observers` command injects the
    // hook on demand as a fallback, it just cannot see the page load.
    log(`observers: registration failed (${err instanceof Error ? err.message : String(err)})`);
  }
}
