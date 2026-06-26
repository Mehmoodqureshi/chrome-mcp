/**
 * src/config.ts — the single source for runtime configuration.
 *
 * Resolves the WebSocket port, the data dir (where the 0600 handshake lives),
 * and the security `Policy` from one place: defaults < env < CLI flags < policy
 * file. Nothing else in the codebase should read `process.argv` or invent its
 * own port/policy — they take a `CliConfig`.
 */

import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { readFileSync } from 'node:fs';

import { DEFAULT_WS_PORT } from '../shared/protocol';
import { type Policy, resolvePolicy } from './security/policy';

export type LogLevel = 'silent' | 'info' | 'debug';
export type BackendPreference = 'extension' | 'cdp';

export interface CliConfig {
  /** Port the bridge binds; 0 = ephemeral (written to the handshake file). */
  wsPort: number;
  /** Directory holding handshake.json and the per-profile workspaces. */
  dataDir: string;
  /** Browser profile (identity). Selects `profiles/<profile>/` under the data dir. */
  profile: string;
  /** Task (run). Artifacts land in `profiles/<profile>/tasks/<task>/`. */
  task: string;
  /** Resolved, fully-defaulted security policy. */
  policy: Policy;
  /** Whether to fall back to a Playwright-driven Chromium when no extension is paired. */
  cdpFallback: boolean;
  /** Optional CDP endpoint to attach to instead of launching (e.g. http://127.0.0.1:9222). */
  cdpEndpoint?: string;
  /** Which backend to prefer when both are available (testing knob). */
  prefer: BackendPreference;
  /** Run the CDP-fallback Chromium headless. */
  headless: boolean;
  /** `--print-pairing`: write the handshake and print its path (never the token). */
  printPairing: boolean;
  /** `--persist-token`: reuse a stable on-disk token so the extension never re-pairs. */
  persistToken: boolean;
  showHelp: boolean;
  showVersion: boolean;
  logLevel: LogLevel;
}

/** Resolve the data dir: `$CHROME_MCP_DATA` or `~/.chrome-mcp`. */
export function resolveDataDir(): string {
  return process.env.CHROME_MCP_DATA ?? join(homedir(), '.chrome-mcp');
}

const DEFAULT_PROFILE = 'default';
const DEFAULT_TASK = 'default';

/**
 * Reduce an arbitrary label to a single safe path segment: no separators, no
 * `..` traversal, no leading dots. Profile/task names become directories under
 * the data dir, so they must never escape it.
 */
export function sanitizeName(name: string, kind: 'profile' | 'task'): string {
  const clean = name.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!clean || clean === '.' || clean === '..') {
    throw new Error(`invalid ${kind} name: ${JSON.stringify(name)}`);
  }
  return clean;
}

/** Active profile: `$CHROME_MCP_PROFILE` (set by `--profile`) or "default". */
export function resolveProfile(): string {
  return sanitizeName(process.env.CHROME_MCP_PROFILE ?? DEFAULT_PROFILE, 'profile');
}

/** Active task: `$CHROME_MCP_TASK` (set by `--task`) or "default". */
export function resolveTask(): string {
  return sanitizeName(process.env.CHROME_MCP_TASK ?? DEFAULT_TASK, 'task');
}

/** `profiles/<profile>/` — holds the Chrome user-data dir and this profile's tasks. */
export function resolveProfileDir(dataDir: string, profile: string): string {
  return join(dataDir, 'profiles', profile);
}

/** `profiles/<profile>/tasks/<task>/` — per-run artifacts (downloads, meta.json). */
export function resolveTaskDir(dataDir: string, profile: string, task: string): string {
  return join(resolveProfileDir(dataDir, profile), 'tasks', task);
}

function readPolicyFile(path: string): Partial<Policy> {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Policy>;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`policy file ${path} did not contain a JSON object`);
  }
  return parsed;
}

/**
 * Parse argv (the slice AFTER `node script`, i.e. `process.argv.slice(2)`) plus
 * env into a fully-resolved `CliConfig`. Pure except for the optional policy-file
 * read triggered by `--policy <path>`.
 */
export function parseArgs(argv: string[]): CliConfig {
  let wsPort = envInt('CHROME_MCP_WS_PORT') ?? DEFAULT_WS_PORT;
  // Extension-only by default: never launch/attach a Chromium of our own unless
  // the operator explicitly opts in with --cdp-fallback (or --prefer cdp / --cdp-endpoint).
  let cdpFallback = false;
  let cdpEndpoint: string | undefined;
  let prefer: BackendPreference = 'extension';
  let headless = false;
  let printPairing = false;
  let persistToken = false;
  let showHelp = false;
  let showVersion = false;
  let logLevel: LogLevel = 'info';

  // Policy assembled from flags, layered over an optional file.
  let policyFile: Partial<Policy> | undefined;
  const policyFlags: Partial<Policy> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        showHelp = true;
        break;
      case '-v':
      case '--version':
        showVersion = true;
        break;
      case '--port':
        wsPort = requireInt(argv[++i], '--port');
        break;
      case '--data-dir':
        process.env.CHROME_MCP_DATA = requireValue(argv[++i], '--data-dir');
        break;
      case '--profile':
        process.env.CHROME_MCP_PROFILE = requireValue(argv[++i], '--profile');
        break;
      case '--task':
        process.env.CHROME_MCP_TASK = requireValue(argv[++i], '--task');
        break;
      case '--policy':
        policyFile = readPolicyFile(requireValue(argv[++i], '--policy'));
        break;
      case '--unsafe-all-domains':
        policyFlags.allowDomains = ['*'];
        break;
      case '--allow-domain':
        (policyFlags.allowDomains ??= []).push(requireValue(argv[++i], '--allow-domain'));
        break;
      case '--enable-mutations':
        policyFlags.enableMutations = true;
        break;
      case '--unsafe-enable-eval':
        policyFlags.allowEval = true;
        break;
      case '--enable-downloads':
        policyFlags.allowDownloads = true;
        break;
      case '--enable-uploads':
        policyFlags.allowUploads = true;
        break;
      case '--uploads-dir':
        policyFlags.uploadsDir = resolvePath(requireValue(argv[++i], '--uploads-dir'));
        break;
      case '--allow-all-tabs':
        policyFlags.allowAllTabs = true;
        break;
      case '--cdp-fallback':
        cdpFallback = true;
        break;
      case '--no-cdp-fallback': // still accepted; fallback is already off by default
        cdpFallback = false;
        break;
      case '--cdp-endpoint':
        cdpEndpoint = requireValue(argv[++i], '--cdp-endpoint');
        break;
      case '--prefer':
        prefer = requirePreference(argv[++i]);
        break;
      case '--headless':
        headless = true;
        break;
      case '--print-pairing':
        printPairing = true;
        break;
      case '--persist-token':
        persistToken = true;
        break;
      case '--log-level':
        logLevel = requireLogLevel(argv[++i]);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  // File first, then flags win.
  const policy = resolvePolicy({ ...policyFile, ...policyFlags });

  // Uploads must be confined to a directory — refuse to start with uploads enabled
  // but no dir, rather than silently allow unrestricted local-file access.
  if (policy.allowUploads && !policy.uploadsDir) {
    throw new Error('--enable-uploads requires --uploads-dir <path> (uploads must be confined to a directory)');
  }

  return {
    wsPort,
    dataDir: resolveDataDir(),
    profile: resolveProfile(),
    task: resolveTask(),
    policy,
    cdpFallback,
    cdpEndpoint,
    prefer,
    headless,
    printPairing,
    persistToken,
    showHelp,
    showVersion,
    logLevel,
  };
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function requireInt(value: string | undefined, flag: string): number {
  const n = Number.parseInt(requireValue(value, flag), 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

function requirePreference(value: string | undefined): BackendPreference {
  if (value === 'extension' || value === 'cdp') return value;
  throw new Error('--prefer must be "extension" or "cdp"');
}

function requireLogLevel(value: string | undefined): LogLevel {
  if (value === 'silent' || value === 'info' || value === 'debug') return value;
  throw new Error('--log-level must be "silent", "info", or "debug"');
}

/** Help text for `--help`. */
export const HELP_TEXT = `chrome-mcp — drive a real Chrome browser over MCP.

Usage: chrome-mcp [options]
       chrome-mcp tasks list [--json]
       chrome-mcp tasks gc   [--older-than <days>] [--keep <n>] [--profile <name>] [--dry-run]

Connection:
  --port <n>             WebSocket bridge port (default ${DEFAULT_WS_PORT}; 0 = ephemeral)
  --data-dir <path>      Override the data dir (default ~/.chrome-mcp)
  --profile <name>       Default browser profile / identity (default "default").
                         Artifacts live under profiles/<name>/. At runtime, switch
                         with the profile_use tool. Several browsers can pair to the
                         SAME port+token at once, each declaring its own Profile in
                         the extension Options; tools route to the active profile.
  --task <name>          Task label (default "default"). Downloads and a meta.json
                         land in profiles/<profile>/tasks/<task>/.
  --print-pairing        Write the handshake and print its path, then exit
  --persist-token        Reuse a stable on-disk token across restarts so the
                         extension never has to re-pair (default: fresh per boot).
                         CHROME_MCP_TOKEN env, if set, pins the token explicitly.

Backend:
  --cdp-fallback         Opt in to launching/attaching Chromium when no extension
                         is paired. OFF by default — extension-only, never opens
                         a browser of its own.
  --no-cdp-fallback      Explicitly disable the fallback (already the default).
  --cdp-endpoint <url>   Attach to an existing Chrome (e.g. http://127.0.0.1:9222)
  --prefer <which>       "extension" (default) or "cdp"
  --headless             Run the CDP-fallback Chromium headless

Security (default: deny-all safe mode):
  --policy <file>        Load a JSON policy file
  --allow-domain <glob>  Add a domain to the allowlist (repeatable)
  --unsafe-all-domains   Allow every domain (loud footgun)
  --enable-mutations     Enable click/type/navigate/… (off by default)
  --unsafe-enable-eval   Enable the eval primitive (off by default)
  --enable-downloads     Enable download_file (off by default)
  --enable-uploads       Enable upload_file — sends local files to a page (off by default)
  --uploads-dir <path>   Restrict upload_file to files inside <path> (recommended with --enable-uploads)
  --allow-all-tabs       Relax tab list/select to all tabs

Misc:
  --log-level <lvl>      silent | info | debug (default info)
  -h, --help             Show this help
  -v, --version          Show version
`;
