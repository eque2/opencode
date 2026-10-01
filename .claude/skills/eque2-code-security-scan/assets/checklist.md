# Security checklist

Fifty checks in seven categories. Each check has a stable ID — the delta
between runs matches on it, so never renumber; retire an ID instead of
reusing it.

Columns: **Check** — what must be true. **Detect** — where to look and what
to look for; these are starting points, not the whole search. **Fix** — the
remediation to recommend. A ✋ marks a check that code alone cannot prove;
it needs an owner's attestation (see SKILL.md, Attest).

## Severity

Banded to the CVSS v4.0 qualitative scale
(https://www.first.org/cvss/v4.0/specification-document). Wording follows
Anthropic's claude-code-security-review
(https://github.com/anthropics/claude-code-security-review).

| Severity | CVSS | Meaning | Examples |
|---|---|---|---|
| Critical | 9.0–10.0 | Unauthenticated, direct exploit: RCE, auth bypass, cross-tenant data, a live leaked secret | Key in git history, RLS off on an exposed table, `pull_request_target` running PR code with secrets |
| High | 7.0–8.9 | Direct exploit that needs a low-privilege account or one easy condition | IDOR, SQL injection behind login, unsigned webhooks |
| Medium | 4.0–6.9 | Needs specific conditions; significant impact | Partial SSRF allowlist, no CSRF defence, unpinned Actions |
| Low | 0.1–3.9 | Defence-in-depth gap | Missing header, no Dependabot |

Rate each finding against the repo in front of you — the examples show the
usual band, not a fixed one.

## BP — Before you push

| ID | Check | Detect | Fix |
|---|---|---|---|
| BP-1 | `.env` files are gitignored and none is tracked | `.gitignore`; `git ls-files \| grep -E '(^\|/)\.env'` (allow `.env.example`) | Add `.env*` + `!.env.example` to `.gitignore`; `git rm --cached` the tracked file; treat its keys as leaked (BP-3) |
| BP-2 | Secret scanning runs as a pre-commit hook | `.pre-commit-config.yaml`, `.husky/`, `lefthook.yml`, `.git/hooks/pre-commit` for `gitleaks`; CI for a gitleaks step | Add the gitleaks pre-commit hook and a CI step; the CI step catches `--no-verify` |
| BP-3 ✋ | Every key that ever reached the remote is rotated | `gitleaks git --redact` over full history, or `git log -p -G '<key regex>' --format='%h %an %ad' --name-only`. Report commit + file + key type, never the value | Rotate each key at its provider, then attest. Rewriting history does not un-leak a pushed key |
| BP-4 | No server secret ships in the frontend bundle | Client code and public env prefixes: `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_` holding `sk_`, `secret`, service-role, OpenAI/Anthropic keys; built `dist/`/`.next/` if present | Move the call behind a server route; keep only publishable keys client-side |
| BP-5 | Dependency versions are pinned and the lockfile is committed | Lockfile tracked (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`); `*`/`latest`/unbounded ranges in manifests; CI uses `npm ci` / `--frozen-lockfile` | Commit the lockfile; install with the frozen flag in CI |

## AA — Auth and access

| ID | Check | Detect | Fix |
|---|---|---|---|
| AA-1 | Every API route enforces auth on the server | Enumerate routes (framework router, `app/api/**`, `pages/api/**`, controllers, edge functions); confirm each hits auth middleware or an explicit public allowlist | Default-deny middleware; list public routes explicitly |
| AA-2 | A user cannot read or change another user's object by changing its ID (IDOR) | Handlers that load by `params.id`/`req.query.id` without scoping to the session user or tenant | Scope every query by owner/tenant, or check ownership after load; add a test with two users |
| AA-3 ✋ | Row Level Security is on for every table the client can reach | Migrations/SQL: `ENABLE ROW LEVEL SECURITY` and policies per table; Supabase/PostgREST exposure; tables without policies. Live DB state needs attestation | Enable RLS on every exposed table with explicit policies; deny by default |
| AA-4 | Auth uses an established provider or library, not a home-rolled scheme | Custom session/token/password code vs Auth.js, Clerk, Auth0, Supabase Auth, Cognito, Firebase, Keycloak, Django auth, Devise | Migrate to the provider; delete the custom code |
| AA-5 | Access tokens are short-lived; refresh tokens are revoked on logout | Token TTL config (`expiresIn`, `ACCESS_TOKEN_LIFETIME`); logout handler invalidates refresh token server-side | Access TTL ≤ 15 min; store and revoke refresh tokens; rotate on use |
| AA-6 | Admin and role checks run on the server | Role checks only in UI components/route guards; server handlers for admin actions without a role check | Enforce roles in server middleware/handlers; UI checks are cosmetic |
| AA-7 | Login, signup and password reset are rate limited | Rate-limit middleware (`express-rate-limit`, `@upstash/ratelimit`, `slowapi`, `django-ratelimit`, gateway config) on those routes | Per-IP and per-account limits; lockout or backoff on reset |
| AA-8 | Cookie-authenticated state changes have CSRF protection | POST/PUT/PATCH/DELETE handlers using cookie sessions without a CSRF token, `SameSite=Lax/Strict`, or Origin check | CSRF tokens or SameSite + Origin verification (OWASP ASVS 5.0, https://owasp.org/projects/asvs) |
| AA-9 | Passwords use a slow hash; tokens use a CSPRNG; TLS verification is on | `md5`/`sha1`/bare `sha256` on passwords; `Math.random()`/`random.random()` for tokens; `verify=False`, `rejectUnauthorized: false`, `InsecureSkipVerify` | argon2id/bcrypt/scrypt; `crypto.randomBytes`/`secrets`; restore TLS verification (OWASP Top 10:2025 A04) |
| AA-10 | JWT verification pins the algorithm and checks `exp`, `aud`, `iss` | `jwt.verify` without `algorithms`; `alg: none`; weak/hard-coded HS256 secret; `jwt.decode()` used for authorisation | Pin algorithms; validate claims; never authorise on an unverified decode |

## ID — Input and data

| ID | Check | Detect | Fix |
|---|---|---|---|
| ID-1 | All input is validated on the server | Handlers reading `req.body`/`params`/form data without a schema (zod, Effect Schema, joi, pydantic, class-validator); validation only in the client | Schema-validate at every server entry point |
| ID-2 | SQL is parameterised | String-built SQL: template literals or concatenation into `query(`, `raw(`, `execute(`, `$queryRawUnsafe`, `sequelize.query`, f-strings in `cursor.execute` | Bound parameters or the ORM's safe builder |
| ID-3 | User content is escaped before render | `dangerouslySetInnerHTML`, `innerHTML`, `v-html`, `{{{ }}}`, `\|safe`, `mark_safe`, markdown→HTML without a sanitiser | Framework escaping; DOMPurify/bleach for required HTML |
| ID-4 | CORS allows only known origins | `Access-Control-Allow-Origin: *`, `cors()` with no options, `origin: true`, origin reflected from the request, `*` with credentials | Explicit origin allowlist per environment |
| ID-5 ✋ | Storage buckets are private by default | IaC/config: `public: true`, `acl: public-read`, Supabase `public` buckets, Firebase storage rules `allow read: if true`, GCS `allUsers` | Private buckets; signed URLs for access |
| ID-6 | File uploads are processed away from the app server | Upload handlers that parse/convert/resize in-process (ImageMagick, sharp, ffmpeg, PDF libs); no type/size check; files stored under the web root | Validate type and size; process in an isolated worker or managed service; store outside the web root |
| ID-7 | Webhook signatures are verified | Webhook routes (Stripe, GitHub, Clerk, Slack, Twilio) without `constructEvent`, `verifySignature`, HMAC compare; non-constant-time compare | Verify the signature on the raw body with the provider SDK before any side effect |
| ID-8 | Server-side fetches of user-supplied URLs are restricted (SSRF) | `fetch`/`axios`/`requests.get`/`http.Get` whose URL comes from input; no allowlist; no block of private ranges and `169.254.169.254` | Allowlist hosts; resolve and reject private IPs; disable redirects (OWASP API7:2023, https://api-security.owasp.org/editions/2023/en/0x11-t10/) |
| ID-9 | No unsafe deserialization or dynamic evaluation of input | `eval(`, `new Function(`, `vm.runIn*`, `pickle.loads`, `yaml.load(` without SafeLoader, `unserialize(`, `ObjectInputStream`, `node-serialize` | Remove eval; use safe loaders and data-only formats (OWASP Top 10:2025 A08) |
| ID-10 | No mass assignment; responses expose only intended fields | `create(req.body)`, `update(req.body)`, `**request.json`; ORM entities returned whole (e.g. `passwordHash` in responses) | Pick allowed fields on write; DTO or `select` on read (OWASP API3:2023) |
| ID-11 | Resource use is bounded | List endpoints without a max `limit`; body parsers without a size limit; uploads without a size cap; GraphQL without depth/complexity limits | Cap page size, body size, upload size, query depth (OWASP API4:2023) |

## AI — AI and agents

| ID | Check | Detect | Fix |
|---|---|---|---|
| AI-1 ✋ | Hard spending caps are set on every AI provider and cloud account | Code cannot show this; note which providers the repo uses (SDK imports, env names) so the owner knows what to attest | Set provider hard limits and billing alerts |
| AI-2 | AI endpoints are rate limited per user | Routes that call an LLM SDK without rate limiting or per-user quota; unauthenticated LLM routes | Auth + per-user rate limit + max tokens per request |
| AI-3 | Model input from outside the trust boundary is treated as untrusted | User text, retrieved documents, web pages, emails or tool results concatenated into prompts that also carry instructions or privileged tool access | Separate instructions from data; restrict tools when untrusted content is in context (OWASP LLM01, https://genai.owasp.org/llm-top-10/) |
| AI-4 | Model-driven tools, SQL and shell are bounded | Tool definitions that run shell, arbitrary SQL, file writes or HTTP without an allowlist, read-only DB role, timeout, or human confirmation | Allowlisted tools, least-privilege credentials, timeouts, confirmation for destructive actions (OWASP LLM06) |
| AI-5 | Every dependency exists and is the intended package | New or unfamiliar deps: check each exists on its registry, its age, downloads, and a name one edit away from a popular package (slopsquatting) | Remove or replace suspect packages; review AI-suggested deps before install |
| AI-6 | Agent config files are reviewed as code | `CLAUDE.md`, `AGENTS.md`, `**/SKILL.md`, `.claude/settings*.json`, `.mcp.json`, hooks: look for instructions to exfiltrate, disable checks, broad `allow` rules, unknown MCP servers, remote scripts piped to a shell | CODEOWNERS on agent config; review changes like code; pin MCP servers |
| AI-7 | Production credentials are out of the agent's reach | Prod keys in `.env` files agents can read; `.claude/settings.json` without `Read` deny rules for secret files; MCP servers configured with prod creds | Separate dev credentials; deny rules for secret files; no prod creds on dev machines |
| AI-8 | Model output is treated as untrusted before render or execution | LLM output reaching `innerHTML`/`dangerouslySetInnerHTML`, unsanitised markdown→HTML, SQL, `exec`, file paths, redirects | Escape/sanitise/validate model output like user input (OWASP LLM05) |
| AI-9 | System prompts hold no secrets; retrieval is scoped per tenant | Keys, internal URLs or credentials in prompt strings; vector queries without a tenant/user filter | Move secrets to server config; filter every retrieval by tenant (OWASP LLM07, LLM08) |
| AI-10 | AI agents in CI cannot be steered by untrusted input | `claude-code-action`, codex, gemini-cli steps triggered by `issue_comment`, `pull_request_target` or issues with write permissions or shell tools | Restrict triggers to trusted actors; read-only token; no shell tools (https://github.com/trailofbits/skills) |

## WB — When it breaks

| ID | Check | Detect | Fix |
|---|---|---|---|
| WB-1 | Clients get generic errors; no stack traces | Error handlers returning `err.stack`/`err.message` raw; `DEBUG=True`/dev error pages in prod config; unhandled rejections reaching responses | Global handler: log detail server-side, return a generic message + correlation ID |
| WB-2 | Logs contain no secrets or PII | Logging of whole `req.body`, headers, tokens, passwords, emails; no redaction config (pino `redact`, structlog processors) | Redaction at the logger; log IDs, not payloads |
| WB-3 | Security-relevant actions are audit-logged | Login, role change, data export, delete, admin actions: is actor + action + target + time recorded durably? | Append-only audit log for these events |
| WB-4 ✋ | Database backups exist and a restore has been tested | Backup config (PITR, snapshot schedules in IaC, provider settings); restore runbook. The test itself needs attestation | Enable automated backups; run and record a restore drill |
| WB-5 | Defaults fail closed | `process.env.X \|\| 'secret'`, auth switches defaulting off, `catch` blocks that call `next()` or return success, feature flags that skip auth when unset | Crash on missing config; deny on error (OWASP Top 10:2025 A10) |

## SC — Supply chain and CI

Source for SC-1 to SC-5: GitHub, *Secure use reference*
(https://docs.github.com/en/actions/reference/security/secure-use).

| ID | Check | Detect | Fix |
|---|---|---|---|
| SC-1 | Third-party Actions are pinned to a full commit SHA | `.github/workflows/*.y*ml`: `uses: owner/repo@<tag or branch>` where the ref is not 40 hex chars (first-party `actions/*` still counts) | Pin to SHA with a version comment; let Dependabot bump |
| SC-2 | `GITHUB_TOKEN` has least privilege | No top-level `permissions:`; `write-all`; write scopes a job does not use | `permissions: contents: read` at top; widen per job |
| SC-3 | No script injection from event data | `run:` blocks interpolating `${{ github.event.* }}`, `github.head_ref`, issue/PR titles or bodies | Pass through `env:` and quote the variable |
| SC-4 | `pull_request_target`/`workflow_run` never runs PR code with secrets | Those triggers plus `actions/checkout` of the PR head ref/SHA, or running scripts from the PR | Use `pull_request`; if needed, split into an unprivileged build and a privileged follow-up |
| SC-5 | CI uses OIDC instead of long-lived cloud keys; workflows have CODEOWNERS | Secrets like `AWS_SECRET_ACCESS_KEY`, `GCP_SA_KEY` without `id-token: write`; `CODEOWNERS` not covering `.github/` | OIDC federation; CODEOWNERS on `.github/` |
| SC-6 | Dependencies are updated and scanned for known vulnerabilities | `.github/dependabot.yml` or `renovate.json`; CI step for `npm audit`/`pnpm audit`/`osv-scanner`/`pip-audit`. Run `osv-scanner scan -r .` if installed and report High+ | Enable Dependabot/Renovate; fail CI on High+ (OWASP Top 10:2025 A03, https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures/) |
| SC-7 | Package install scripts are restricted | `.npmrc` without `ignore-scripts=true`; pnpm without `onlyBuiltDependencies`; deps with `preinstall`/`postinstall`; archived upstream repos | Disable scripts by default; allowlist the packages that need them |

## TH — Transport and headers

| ID | Check | Detect | Fix |
|---|---|---|---|
| TH-1 | Security headers are set: CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors` | `helmet(`, `headers()` in `next.config.*`, `vercel.json`, `netlify.toml`, nginx/Caddy config; `unsafe-inline`/`unsafe-eval` in CSP | Set the headers centrally; tighten CSP (https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html) |
| TH-2 | Session cookies are `Secure`, `HttpOnly`, `SameSite` | Cookie options: `httpOnly: false`, missing `secure`, `sameSite: 'none'` without CSRF defence | Set all three flags (https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) |
