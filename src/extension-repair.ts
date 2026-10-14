/** Diagnose extension registrations without reading browser history or extension storage. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { STORE_EXTENSION_ID } from '../shared/protocol';
import { writeFileAtomic } from './atomic-file';
import { browserHostDirs } from './native-host';

interface Installation {
  path?: string;
  location?: number;
  from_webstore?: boolean;
  disable_reasons?: number[] | number;
  manifest?: { name?: string };
}
interface Preferences {
  extensions?: { settings?: Record<string, Installation> };
  [key: string]: unknown;
}
export interface ExtensionRegistration {
  id: string;
  source: 'unpacked' | 'web-store' | 'other';
  path: string;
  manifestReadable: boolean;
  diskId?: string;
  disableReasons: number[];
  preferenceFile: string;
}
export interface ExtensionDiagnosis {
  profileDir: string;
  registrations: ExtensionRegistration[];
  /** Only proven conflicts with a valid current registration in the same folder. */
  staleIds: string[];
  issues: string[];
}
export interface ExtensionScan {
  profiles: ExtensionDiagnosis[];
  errors: string[];
}

export function browserDataDirs(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome SxS',
      'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft/Edge', 'Vivaldi'].map(p => join(base, p, 'User Data'));
  }
  return browserHostDirs(platform, home).map(dirname);
}

/** Chrome derives keyed extension IDs from the first 128 bits of the public-key hash. */
export function extensionIdFromKey(key: unknown): string | undefined {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(key)) return undefined;
  const bytes = Buffer.from(key, 'base64');
  if (!bytes.length) return undefined;
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + Number.parseInt(c, 16)));
}

function readPreferences(file: string): { raw: string; data: Preferences } {
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw) as Preferences;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected a JSON object');
  const settings = data.extensions?.settings;
  if (settings && (typeof settings !== 'object' || Array.isArray(settings))) throw new Error('invalid extension settings');
  return { raw, data };
}

export function inspectExtensionProfiles(roots = browserDataDirs()): ExtensionScan {
  const result: ExtensionScan = { profiles: [], errors: [] };
  for (const root of new Set(roots.map(p => resolve(p)))) {
    if (!existsSync(root)) continue;
    let profiles: string[];
    try {
      profiles = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(root, e.name));
    } catch {
      result.errors.push(`Cannot read browser directory: ${root}`);
      continue;
    }
    for (const profileDir of profiles) {
      const registrations: ExtensionRegistration[] = [];
      for (const name of ['Preferences', 'Secure Preferences']) {
        const file = join(profileDir, name);
        if (!existsSync(file)) continue;
        try {
          const { data } = readPreferences(file);
          for (const [id, entry] of Object.entries(data.extensions?.settings ?? {})) {
            if (!entry || typeof entry.path !== 'string') continue;
            const path = isAbsolute(entry.path) ? entry.path : join(profileDir, 'Extensions', entry.path);
            let manifest: { key?: string; name?: string } | undefined;
            try {
              const value = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
              if (value && typeof value === 'object' && !Array.isArray(value)) manifest = value;
            } catch { /* report missing files for known registrations below */ }
            const diskId = extensionIdFromKey(manifest?.key);
            const name = manifest?.name ?? entry.manifest?.name ?? '';
            if (id !== STORE_EXTENSION_ID && diskId !== STORE_EXTENSION_ID &&
                !/mcp.*(?:browser|chrome)|chrome.*mcp/i.test(name)) continue;
            registrations.push({
              id, path, preferenceFile: file, manifestReadable: !!manifest, diskId,
              source: entry.location === 4 ? 'unpacked' : entry.from_webstore ? 'web-store' : 'other',
              disableReasons: Array.isArray(entry.disable_reasons) ? entry.disable_reasons :
                typeof entry.disable_reasons === 'number' && entry.disable_reasons ? [entry.disable_reasons] : [],
            });
          }
        } catch {
          result.errors.push(`Cannot parse browser preferences: ${file}`);
        }
      }
      if (!registrations.length) continue;
      const current = registrations.filter(r => r.id === STORE_EXTENSION_ID && r.manifestReadable &&
        (r.source === 'web-store' || r.diskId === STORE_EXTENSION_ID));
      const staleIds = [...new Set(registrations.filter(r => r.source === 'unpacked' &&
        r.id !== STORE_EXTENSION_ID && r.diskId === STORE_EXTENSION_ID &&
        current.some(c => c.path === r.path && c.preferenceFile === r.preferenceFile)).map(r => r.id))];
      const issues: string[] = [];
      for (const r of registrations) {
        if (!r.manifestReadable) issues.push(`${r.id}: extension files are missing or unreadable`);
        if (r.source === 'unpacked' && r.diskId && r.diskId !== r.id) {
          issues.push(`${r.id}: saved ID differs from the manifest ID ${r.diskId}`);
        }
        if (r.disableReasons.length) issues.push(`${r.id}: Chrome disable reason(s): ${r.disableReasons.join(', ')}`);
      }
      if (staleIds.length) issues.push('Confirmed stale unpacked registration blocks the current extension folder at browser startup.');
      result.profiles.push({ profileDir, registrations, staleIds, issues });
    }
  }
  return result;
}

/** Fail closed if process inspection fails; never stop a person's browser automatically. */
export function assertBrowsersClosed(): void {
  let running: boolean;
  try {
    if (process.platform === 'win32') {
      const tasks = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      running = /^"(?:chrome|chromium|msedge|brave|vivaldi|arc)\.exe"/im.test(tasks);
    } else {
      const tasks = execFileSync('ps', ['-ax', '-o', 'comm='], { encoding: 'utf8', timeout: 10_000 });
      running = tasks.split('\n').some(line =>
        /\/(?:Google Chrome[^/]*|Chromium|Brave Browser[^/]*|Microsoft Edge[^/]*|Vivaldi|Arc)\.app\//.test(line) ||
        /(?:^|\/)(?:chrome|chromium|chromium-browser|msedge|brave|brave-browser|vivaldi|vivaldi-bin)(?:\s|$)/.test(line));
    }
  } catch {
    throw new Error('Cannot verify that browsers are closed. No browser preferences were changed.');
  }
  if (running) throw new Error('Fully quit Chrome and other Chromium browsers, then run the repair again. No browser preferences were changed.');
}

export interface RepairOptions {
  roots?: string[];
  backupDir: string;
  apply?: boolean;
  /** Test seam: production always uses the process check above. */
  checkBrowsersClosed?: () => void;
}
export interface RepairResult {
  scan: ExtensionScan;
  removed: Array<{ profileDir: string; id: string }>;
  backup?: string;
  applied: boolean;
}

export function repairExtensionProfiles(opts: RepairOptions): RepairResult {
  const scan = inspectExtensionProfiles(opts.roots);
  const result: RepairResult = { scan, removed: [], applied: false };
  if (!opts.apply || !scan.profiles.some(p => p.staleIds.length)) return result;
  if (scan.errors.length) throw new Error(`${scan.errors.join('\n')}\nNo browser preferences were changed.`);
  const check = opts.checkBrowsersClosed ?? assertBrowsersClosed;
  check();
  const edits: Array<{ file: string; before: string; after: string; mode: number }> = [];
  for (const profile of scan.profiles) {
    for (const file of new Set(profile.registrations.filter(r => profile.staleIds.includes(r.id)).map(r => r.preferenceFile))) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to edit a linked or non-regular preference file: ${file}`);
      const { raw, data } = readPreferences(file);
      for (const id of profile.staleIds) {
        const record = data.extensions?.settings?.[id];
        const inspected = profile.registrations.find(r => r.id === id && r.preferenceFile === file);
        if (!record || !inspected) continue;
        const current = data.extensions?.settings?.[STORE_EXTENSION_ID];
        if (record.location !== 4 || record.path !== inspected.path || current?.path !== record.path || current.location !== 4 ||
            extensionIdFromKey(JSON.parse(readFileSync(join(inspected.path, 'manifest.json'), 'utf8')).key) !== STORE_EXTENSION_ID) {
          throw new Error('Browser preferences or extension identity changed during inspection. Run the repair again.');
        }
        delete data.extensions!.settings![id];
        result.removed.push({ profileDir: profile.profileDir, id });
      }
      edits.push({ file, before: raw, after: JSON.stringify(data), mode: stat.mode & 0o777 });
    }
  }
  // Only obsolete extension records change. The current registration, hashes,
  // cookies, extension storage, profile names, tokens and proxy settings stay intact.
  mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
  result.backup = mkdtempSync(join(opts.backupDir, 'extension-repair-'));
  edits.forEach((edit, i) => writeFileSync(join(result.backup!, `${i}.json`), edit.before, { mode: 0o600 }));
  writeFileSync(join(result.backup, 'restore.json'), JSON.stringify(edits.map((e, i) => ({ original: e.file, backup: `${i}.json` })), null, 2), { mode: 0o600 });
  check();
  for (const edit of edits) {
    if (readFileSync(edit.file, 'utf8') !== edit.before) throw new Error(`Browser preferences changed; stopped. Backup: ${result.backup}`);
  }
  for (const edit of edits) {
    check();
    if (readFileSync(edit.file, 'utf8') !== edit.before) throw new Error(`Browser preferences changed; stopped. Backup: ${result.backup}`);
    writeFileAtomic(edit.file, edit.after, edit.mode);
  }
  result.applied = true;
  return result;
}
