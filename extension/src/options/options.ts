/**
 * extension/src/options/options.ts — the manual pairing UI. Persists {wsPort,
 * token} to chrome.storage.local (which the background SW watches) and asks it
 * to (re)connect. Also reflects the live connection state.
 */

const portEl = document.getElementById('port') as HTMLInputElement;
const tokenEl = document.getElementById('token') as HTMLInputElement;
const saveEl = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

async function loadExisting(): Promise<void> {
  const { wsPort, connState } = await chrome.storage.local.get(['wsPort', 'connState']);
  if (typeof wsPort === 'number') portEl.value = String(wsPort);
  render(typeof connState === 'string' ? connState : 'idle');
}

function render(state: string): void {
  const labels: Record<string, string> = {
    connected: '✅ connected',
    connecting: '… connecting',
    unauthorized: '⛔ rejected (bad/stale token — re-paste)',
    idle: '○ not connected',
  };
  statusEl.textContent = `Status: ${labels[state] ?? state}`;
}

saveEl.addEventListener('click', async () => {
  const wsPort = Number(portEl.value);
  const token = tokenEl.value.trim();
  if (!Number.isInteger(wsPort) || wsPort < 0 || !token) {
    statusEl.textContent = 'Status: enter a valid port and token';
    return;
  }
  await chrome.storage.local.set({ wsPort, token });
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => undefined);
  statusEl.textContent = 'Status: … connecting';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.connState) render(String(changes.connState.newValue));
});

void loadExisting();
