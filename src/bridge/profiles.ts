/**
 * src/bridge/profiles.ts — automatic profile names for paired browsers.
 *
 * Chrome gives an extension no way to learn which Chrome profile it runs in, so
 * before this every browser that left Profile blank paired as "default" — and a
 * second one silently superseded the first. Now each extension install sends a
 * stable random `installId` (kept in that profile's chrome.storage.local), and
 * the server gives each install its own name: "default" for the first,
 * "profile-2", "profile-3", ... after that. The mapping persists in
 * `<dataDir>/profiles.json`, so a browser keeps its name across restarts and
 * `profile_rename` can give it a friendly one.
 *
 * A Profile typed into the extension's Options still wins — that label is the
 * user's explicit choice and is never renamed from here.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sanitizeName } from '../config';

export const REGISTRY_FILE = 'profiles.json';

/** The name the first auto-named browser gets — the pre-registry default. */
export const FIRST_AUTO_NAME = 'default';

interface InstallRecord {
  name: string;
  firstSeen: string;
  lastSeen: string;
}

interface RegistryFile {
  installs: Record<string, InstallRecord>;
}

/** An installId is opaque, but it becomes a JSON key and a log line: keep it tame. */
export function isValidInstallId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

export class ProfileRegistry {
  private installs: Record<string, InstallRecord> = {};

  /** `dataDir` undefined → in-memory only (tests, and servers run without one). */
  constructor(private readonly dataDir?: string) {
    this.load();
  }

  /** The name already assigned to this install, if any. */
  nameOf(installId: string): string | undefined {
    return this.installs[installId]?.name;
  }

  /** The install that owns `name` in the registry, if any. */
  ownerOf(name: string): string | undefined {
    for (const [id, rec] of Object.entries(this.installs)) if (rec.name === name) return id;
    return undefined;
  }

  /**
   * Name for an install with no explicit label: its remembered name, else the
   * first of "default", "profile-2", ... that no other install owns and
   * `isLive(name)` doesn't report as held by someone else right now.
   */
  assign(installId: string, isLive: (name: string) => boolean): string {
    const now = new Date().toISOString();
    const known = this.installs[installId];
    if (known) {
      known.lastSeen = now;
      this.save();
      return known.name;
    }
    let name = FIRST_AUTO_NAME;
    for (let n = 2; this.ownerOf(name) !== undefined || isLive(name); n++) name = `profile-${n}`;
    this.installs[installId] = { name, firstSeen: now, lastSeen: now };
    this.save();
    return name;
  }

  /**
   * Give the install currently named `from` the name `to`. Throws when `from`
   * isn't an auto-named install or `to` is already owned by another one; the
   * caller checks live connections (explicitly labelled browsers aren't here).
   */
  rename(from: string, to: string): string {
    const target = sanitizeName(to, 'profile');
    const id = this.ownerOf(from);
    if (id === undefined) {
      throw new Error(
        `"${from}" is not an automatically named profile. A name typed into the ` +
          `extension's Options can only be changed there.`,
      );
    }
    if (target === from) return target;
    if (this.ownerOf(target) !== undefined) throw new Error(`profile "${target}" is already taken`);
    this.installs[id].name = target;
    this.save();
    return target;
  }

  private load(): void {
    if (!this.dataDir) return;
    const path = join(this.dataDir, REGISTRY_FILE);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryFile>;
      for (const [id, rec] of Object.entries(parsed.installs ?? {})) {
        if (isValidInstallId(id) && rec && typeof rec.name === 'string') this.installs[id] = rec;
      }
    } catch {
      // A corrupt file must not stop pairing: start empty and rewrite on next save.
    }
  }

  private save(): void {
    if (!this.dataDir) return;
    const path = join(this.dataDir, REGISTRY_FILE);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ installs: this.installs } satisfies RegistryFile, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // Best-effort: names still work for this run, they just won't persist.
    }
  }
}
