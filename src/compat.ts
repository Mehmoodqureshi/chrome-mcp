import { existsSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/** New configuration names take precedence; existing installations still work. */
export function runtimeEnv(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MCP_BROWSER_EXTENSION_${key}`] ?? env[`CHROME_MCP_${key}`];
}

/** Expose the new path without moving files that a running browser still uses. */
export function renamedDirectory(home: string, name: string, legacyName: string): string {
  const current = join(home, name);
  const legacy = join(home, legacyName);
  if (existsSync(current) || !existsSync(legacy)) return current;
  try {
    if (!statSync(legacy).isDirectory()) return current;
    symlinkSync(legacy, current, process.platform === 'win32' ? 'junction' : 'dir');
    return current;
  } catch {
    // Another process may have created the alias, or the home may be read-only.
    return existsSync(current) ? current : legacy;
  }
}
