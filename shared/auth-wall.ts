/**
 * shared/auth-wall.ts — decide whether a page is a login wall.
 *
 * A browser agent that reuses a signed-in Chrome profile still hits the moment
 * the session cookie expires mid-run: the next page is a sign-in form, and
 * every later step fails for a reason that has nothing to do with the task.
 * Without a distinct signal, an eval harness buckets that as SELECTOR_NOT_FOUND
 * or TIMEOUT and the run is scored as an agent failure instead of an auth
 * failure.
 *
 * This module is the pure decision. It reads only what an accessibility
 * snapshot already carries (URL, title, password fields, button/link names), so
 * it works identically on both backends and needs nothing new from the
 * extension. Server-side callers attach the verdict to snapshot results, expose
 * it as `auth_check`, and can turn it into an `AUTH_REQUIRED` error.
 */

export type AuthWallConfidence = 'high' | 'medium';

export type AuthWallSignal =
  | 'password-field'
  | 'login-url'
  | 'identity-provider'
  | 'login-title'
  | 'login-button'
  | 'username-field';

export interface AuthWall {
  detected: true;
  confidence: AuthWallConfidence;
  signals: AuthWallSignal[];
}

/** The subset of a snapshot the detector reads. */
export interface AuthWallPage {
  url: string;
  title: string;
  nodes: Array<{ role: string; name: string; tag: string; secret?: boolean }>;
}

/** Path segments that mark a sign-in route on most stacks. */
const LOGIN_PATH =
  /(^|[\/._-])(login|log-in|logon|log-on|signin|sign-in|sign_in|authenticate|auth|sso|oauth2?|saml|sessions?\/new|users\/sign_in|account\/login|idp)([\/?#._-]|$)/i;

/** Hosts (or host suffixes) that are identity providers, whatever the path. */
const IDP_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'appleid.apple.com',
  'login.yahoo.com',
  'auth0.com',
  'okta.com',
  'oktapreview.com',
  'onelogin.com',
  'pingidentity.com',
  'duosecurity.com',
  'github.com/login',
  'login.salesforce.com',
  'signin.aws.amazon.com',
  'auth.atlassian.com',
  'id.atlassian.com',
  'login.linkedin.com',
];

const LOGIN_TITLE = /\b(sign in|sign-in|signin|log in|log-in|login|log on|logon|authenticate|authentication required|session (has )?expired|session timed out|please sign in|please log in|verify it'?s you)\b/i;

/** Button/link labels that submit or start a sign-in. Anchored so a header "Sign in" link with extra copy still matches only when the label is the action. */
const LOGIN_BUTTON = /^(sign in|sign-in|signin|log in|log-in|login|log on|logon|continue|next|submit|authenticate|(sign|log) ?in (with|via|using) .{1,40}|continue with .{1,40}|use (your )?password|sign in to continue|log in to continue)$/i;

/** Labels that mark a credential's username half; only a booster, never a wall on its own. */
const USERNAME_FIELD = /\b(email|e-mail|username|user name|user id|userid|phone|account|login id)\b/i;

/** The action-shaped labels that, next to a password field, make this a form and not a "change password" settings page. */
const STRONG_BUTTON = /^(sign in|sign-in|signin|log in|log-in|login|log on|logon|authenticate|sign in to continue|log in to continue|(sign|log) ?in (with|via|using) .{1,40}|continue with .{1,40})$/i;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isIdpHost(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  const hostAndPath = `${host}${u.pathname}`.toLowerCase();
  return IDP_HOSTS.some((h) => {
    if (h.includes('/')) return hostAndPath === h || hostAndPath.startsWith(`${h}/`);
    return host === h || host.endsWith(`.${h}`);
  });
}

/**
 * Inspect a page and return a verdict, or `null` when it does not look like a
 * login wall.
 *
 * Confidence:
 * - `high`: a password field plus a sign-in control, title, or URL; or a
 *   sign-in URL plus a sign-in control or title; or an identity-provider host.
 * - `medium`: exactly one weaker cue on its own (a password field, or a
 *   sign-in URL) with nothing to corroborate it. Callers that fail a run on a
 *   wall should usually require `high`.
 *
 * A lone "Sign in" link or a title mention never counts: most public pages have
 * one in the header.
 */
export function detectAuthWall(page: AuthWallPage): AuthWall | null {
  const signals = new Set<AuthWallSignal>();
  const u = parseUrl(page.url);

  if (u && LOGIN_PATH.test(u.pathname)) signals.add('login-url');
  if (u && isIdpHost(u)) signals.add('identity-provider');
  if (LOGIN_TITLE.test(page.title || '')) signals.add('login-title');

  let strongButton = false;
  for (const n of page.nodes) {
    if (n.secret === true || (n.tag === 'input' && n.role === 'textbox' && /password/i.test(n.name))) {
      signals.add('password-field');
      continue;
    }
    const label = (n.name || '').trim();
    if (!label) continue;
    const clickable = n.role === 'button' || n.role === 'link' || n.tag === 'button';
    if (clickable && LOGIN_BUTTON.test(label)) {
      signals.add('login-button');
      if (STRONG_BUTTON.test(label)) strongButton = true;
    } else if ((n.role === 'textbox' || n.role === 'combobox') && USERNAME_FIELD.test(label)) {
      signals.add('username-field');
    }
  }

  const has = (s: AuthWallSignal): boolean => signals.has(s);
  const password = has('password-field');
  const loginUrl = has('login-url');
  const idp = has('identity-provider');
  const title = has('login-title');

  let confidence: AuthWallConfidence | null = null;
  if (idp) confidence = 'high';
  else if (password && (strongButton || title || loginUrl || has('username-field'))) confidence = 'high';
  else if (loginUrl && (strongButton || title || has('username-field'))) confidence = 'high';
  else if (password || loginUrl) confidence = 'medium';

  if (!confidence) return null;
  const order: AuthWallSignal[] = [
    'password-field',
    'identity-provider',
    'login-url',
    'login-title',
    'login-button',
    'username-field',
  ];
  return { detected: true, confidence, signals: order.filter(has) };
}

/** A one-line, human-readable explanation for error messages and logs. */
export function describeAuthWall(wall: AuthWall, url: string): string {
  return `the page at ${url} looks like a sign-in wall (${wall.confidence} confidence: ${wall.signals.join(', ')}); the session has probably expired`;
}
