// Secret redaction for text that leaves this gateway (guest replies to other people, exported history).
//
// Since 2026.10.10 (#169063) the gateway no longer masks credentials in tool arguments and results, so an agent that
// read a .env or printed a token can pass it on in plain text. This is a conservative port of the common patterns from
// the gateway's own redactor (src/logging/redact-patterns.ts, 2026.11.6): vendor token prefixes, bearer/Authorization
// values, URL credentials, private key blocks, and secret-named assignments. It favours not touching ordinary prose
// over catching every possible secret; it is a safety net, not a vault.

export const REDACTED = '[REDACTED]';

// Private keys first: the body is base64 that other patterns would otherwise cut into pieces. An unterminated block
// (a truncated tool result) is redacted to the end of the text.
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

// Token shapes with a distinctive prefix. Group 1 is the secret (some patterns keep a leading boundary character).
const VENDOR_TOKENS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,                       // OpenAI, Anthropic (sk-ant-...), OpenRouter, ...
  /(gh[pousr]_[A-Za-z0-9]{10,})/g,                      // GitHub ghp_ gho_ ghu_ ghs_ ghr_
  /(github_pat_[A-Za-z0-9_]{10,})/g,
  /(glpat-[A-Za-z0-9._=-]{20,})/g,                      // GitLab
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,                    // Slack
  /(xapp-[A-Za-z0-9-]{10,})/g,
  /(https:\/\/hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/]{20,})/g,
  /(https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{40,})/g,
  /(gsk_[A-Za-z0-9_-]{10,})/g,                          // Groq
  /(AIza[0-9A-Za-z_-]{30,})/g,                          // Google API keys (39 chars)
  /(ya29\.[0-9A-Za-z_./+=-]{10,})/g,                    // Google OAuth access tokens
  /(GOCSPX-[A-Za-z0-9_-]{20,})/g,
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, // JWTs
  /(pplx-[A-Za-z0-9_-]{10,})/g,
  /(xai-[A-Za-z0-9]{30,})/g,
  /(hf_[A-Za-z0-9]{10,})/g,                             // Hugging Face
  /(npm_[A-Za-z0-9]{10,})/g,
  /(pypi-[A-Za-z0-9_-]{10,})/g,
  /([sr]k_(?:live|test)_[A-Za-z0-9]{10,})/g,            // Stripe
  /(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,      // SendGrid
  /((?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9]))/g, // AWS access key ids
  /(\d{8,10}:AA[A-Za-z0-9_-]{33})/g,                    // Telegram bot tokens
];

// Authorization: Bearer xxx / Basic xxx / Token xxx (headers, curl -H "...", JSON "Authorization": "..."): keep the scheme.
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|bot)\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
// A bare "Bearer <long token>" outside a header. 18+ characters: shorter is prose ("bearer of bad news").
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{18,})(?![A-Za-z0-9._~+/=-])/gi;
// user:password@ in a URL: keep the scheme, user and host.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s/@:"'<>]+:)([^\s/@"'<>]{1,200})(@)/gi;
// ENV_STYLE_NAME=value / "NAME": "value" where the name ends in KEY/TOKEN/SECRET/PASSWORD: upper-case names only, so
// "monkey: 3" or "the token: here" stay.
const ENV_ASSIGNMENT = /\b((?:[A-Z][A-Z0-9]*_)*(?:API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|REFRESH_?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CLIENT_?SECRET)\b["']?\s*[=:]\s*)(["']?)(?!\[REDACTED\])([^\s"'\\,;]{6,})\2/g;
// JSON/YAML keys naming a secret, with a quoted value ("apiKey": "...", \"password\": \"...\" inside an escaped string).
const JSON_FIELD = /(\\*"(?:api[-_]?key|apikey|x-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key|secret|password|passwd|passphrase|token|bearer[-_]?token|authorization|proxy-authorization|cookie|set-cookie)\\*"\s*:\s*\\*")(?!(?:bearer\s+|basic\s+|token\s+|bot\s+)?\[REDACTED\])([^"\\]{3,})/gi;
// key=value in query strings, CLI flags and config lines (lower-case): the value stops at whitespace, &, quotes.
const KEY_VALUE = /((?:^|[\s?&,;({[])(?:--?)?(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|client[-_]?secret|secret[-_]?key|private[-_]?key|password|passwd|passphrase|secret|token)=)(["'`]?)(?!\[REDACTED\])([^\s&#"'`<>]{4,})/gi;
// "password: hunter2" in a config or a chat: only a value that looks like a credential (has a digit or symbol), so
// "password: required" or "token: none" in prose stay.
const COLON_PASSWORD = /(\b(?:password|passwd|passphrase)\s*:\s*)(["'`]?)(?!\[REDACTED\])([^\s"'`,;]{6,})/gi;

const looksLikeCredential = v => /[^A-Za-z]/.test(v);

/**
 * `text` with credentials replaced by [REDACTED]. Non-strings pass through. `onRedact` (optional) is called once per
 * replacement, for callers that count.
 * @param {unknown} text
 * @param {() => void} [onRedact]
 */
export function redactSecrets(text, onRedact) {
  if (typeof text !== 'string' || text.length < 8) return text;
  const hit = () => { onRedact?.(); return REDACTED; };
  let out = text.replace(PEM, hit);
  out = out.replace(AUTH_HEADER, (_m, head) => head + hit());
  out = out.replace(BEARER, (_m, head) => head + hit());
  out = out.replace(URL_CREDENTIALS, (_m, head, _pw, at) => head + hit() + at);
  for (const re of VENDOR_TOKENS) {
    out = out.replace(re, (match, secret) => {
      const bare = secret.replace(/^[^A-Za-z0-9]/, '');
      return match.replace(bare, hit);
    });
  }
  out = out.replace(ENV_ASSIGNMENT, (_m, head, quote, _v) => head + quote + hit() + quote);
  out = out.replace(JSON_FIELD, (_m, head) => head + hit());
  out = out.replace(KEY_VALUE, (_m, head, quote) => head + quote + hit());
  out = out.replace(COLON_PASSWORD, (m, head, quote, value) => (looksLikeCredential(value) ? head + quote + hit() : m));
  return out;
}
