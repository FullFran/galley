# Deploying galley

Runbook for the first production deployment: frontend on GitHub Pages at
`https://galley.fullfran.com`, API on the VPS behind the existing Traefik at
`https://galley-api.fullfran.com`. Do the steps in order. Items marked
**[unverified]** could not be checked without the live systems.

Artifacts in this repository:

- `.github/workflows/pages.yml`: builds `web/` and deploys it to Pages on every
  push to `main` that touches `web/`, or on manual dispatch.
- `server/Dockerfile`: static binary on `distroless/static` (non-root, uid
  65532), data in the `/pb/pb_data` volume.
- `deploy/compose.yml` and `deploy/.env.example`: the `galley-api` service with
  Traefik labels, following the shadow-dungeon API pattern.

## 1. Create the GitHub App

**Owner:** create it under the organization that owns the paper repository
(`Tesis-Francisco-Olmedo`), with "Where can this GitHub App be installed?" set
to **Only on this account**. A private app can only be installed on the
account that owns it, so an app owned by your personal account could not be
installed on the org's repository without making it public ("Any account").
An org-owned private app keeps it installable only there. Org owners can
manage it; add yourself as an app manager if you are not an owner.

Org settings > Developer settings > GitHub Apps > **New GitHub App**:

| Field | Value |
| --- | --- |
| GitHub App name | `galley` (any free name) |
| Homepage URL | `https://galley.fullfran.com` |
| Callback URL | `https://galley-api.fullfran.com/api/galley/auth/callback` |
| Expire user authorization tokens | **On** |
| Request user authorization (OAuth) during installation | **Off** |
| Enable Device Flow | Off |
| Setup URL | empty |
| Webhook: Active | **On** |
| Webhook URL | `https://galley-api.fullfran.com/api/galley/auth/webhook` |
| Webhook secret | the value generated in step 2 |
| Repository permissions | Contents: **Read and write**; Pull requests: **Read and write**; Metadata: **Read-only** (mandatory) |
| Organization / account permissions | none |
| Subscribe to events | none |
| Where can this GitHub App be installed? | Only on this account |

No event subscription is needed for revocation: "A GitHub App receives this
webhook by default and cannot unsubscribe from this event"
(`github_app_authorization`,
<https://docs.github.com/en/webhooks/webhook-events-and-payloads#github_app_authorization>).

After creating it, on the app's **General** page:

- Copy the **Client ID** (starts with `Iv`) into `GALLEY_GITHUB_CLIENT_ID`.
- Click **Generate a new client secret** and copy it once into
  `GALLEY_GITHUB_CLIENT_SECRET`.
- No private key is needed: galley only uses user access tokens.

Then **Install App** > the organization > **Only select repositories** >
`paper-tld100-glow-curve`.

## 2. Generate secrets

Generate on your own machine and keep them in your password manager.

| Variable | Command | Format the server expects |
| --- | --- | --- |
| `GALLEY_TOKEN_KEY` | `openssl rand -base64 32` | standard base64 of exactly 32 bytes (44 characters); checked at start-up |
| `PB_ENCRYPTION_KEY` | `openssl rand -base64 24` | exactly **32 characters** (used as raw AES-256 key bytes; `-base64 32` gives 44 characters and is wrong) |
| `GALLEY_WEBHOOK_SECRET` | `openssl rand -hex 32` | any string; must equal the app's webhook secret |

PocketBase source: <https://pocketbase.io/docs/going-to-production/> ("random
32 characters").

## 3. Cloudflare DNS

| Name | Type | Target | Proxy |
| --- | --- | --- | --- |
| `galley` | CNAME | `fullfran.github.io` | **DNS only** (grey cloud) |
| `galley-api` | same as `sd-api` (A/AAAA to the VPS or CNAME) | the VPS | same as `sd-api` |

Make `galley-api` match how `sd-api` is set up, so Traefik obtains its
certificate the same way. **[unverified]** If `sd-api` is proxied (orange
cloud), the Traefik IP allowlist sees Cloudflare addresses, not yours; keep the
default allowlist and use the SSH tunnel for the admin UI.

## 4. GitHub Pages

1. Verify the domain first (prevents subdomain takeover): profile picture >
   **Settings** > **Pages** > **Add a domain** > `fullfran.com`. Create the TXT
   record it shows, named `_github-pages-challenge-FullFran.fullfran.com`, wait
   for DNS, then **Verify**. Keep the record. Verification also covers immediate
   subdomains such as `galley` (source:
   <https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages>).
   Skip if `fullfran.com` is already verified.
2. `FullFran/galley` > Settings > Pages > Build and deployment > Source:
   **GitHub Actions**.
3. Run the **Pages** workflow (Actions > Pages > Run workflow) or merge to
   `main`. `web/public/CNAME` carries `galley.fullfran.com`.
4. Custom domain: `galley.fullfran.com` > Save; once the certificate is issued,
   tick **Enforce HTTPS**.

Note: `www.fullfran.com` currently has Enforce HTTPS off; consider enabling it
in that repository too.

## 5. VPS

All remote steps run as you, over your usual SSH access.

1. Copy the repository (the build needs `server/`):
   `git clone https://github.com/FullFran/galley.git ~/galley && cd ~/galley && git checkout <release commit>`
2. `cd deploy && cp .env.example .env && chmod 600 .env`, then fill it:
   values from steps 1 and 2, plus `TRAEFIK_NETWORK` and
   `TRAEFIK_CERTRESOLVER`. The shadow-dungeon plan names `dokploy-network` and
   `letsencrypt`; confirm both against the running Traefik
   (`docker network ls`, Traefik static config) **[unverified]**.
3. `docker compose up -d --build`, then `docker compose logs galley-api`.
   `serve` exits with `config: <VAR> ...` if a variable is missing or invalid.
4. Create the superuser over an SSH tunnel. The container publishes 8090 only
   on the VPS loopback as `127.0.0.1:8091`:
   `ssh -L 8091:127.0.0.1:8091 <vps>` and open `http://127.0.0.1:8091/_/`.
   On first start, the logs print a `/_/#/pbinstall/...` link; replace its
   host with `127.0.0.1:8091`. Alternative without the browser:
   `docker compose exec galley-api /pb/galley-api --dir=/pb/pb_data --encryptionEnv=PB_ENCRYPTION_KEY superuser upsert <email> <password>`.
5. In the admin UI, Settings > Application:
   - **User IP proxy headers**: `X-Real-IP` (set by Traefik) or
     `X-Forwarded-For`, so rate limits see client IPs **[unverified]: check
     the IP shown in Logs after a request**.
   - **Rate limiting**: enable it (defaults are a reasonable start; tighten
     `*:auth`).
6. Optional: superuser MFA/OTP (needs SMTP, not configured) and
   `GALLEY_ADMIN_ALLOWLIST` in `.env` for admin access without the tunnel.
   With the default `127.0.0.1/32`, Traefik refuses `/_/` and
   `/api/collections/_superusers` to every public client.

## 6. Paper repository settings

`Tesis-Francisco-Olmedo/paper-tld100-glow-curve`:

- Settings > General > Pull Requests: enable **Automatically delete head
  branches** (galley recreates its `galley/<login>` branch when needed).
- Settings > Branches (or Rules): protect `main`: require a pull request
  before merging, 1 approval, no force pushes, no deletion.
- Invite the directors to the organization with access to the repository.

## 7. First-run checklist

1. `curl https://galley-api.fullfran.com/api/galley/health` returns
   `{"status":"ok"}`.
2. `curl -I https://galley-api.fullfran.com/_/` returns 403 from outside.
3. `https://galley.fullfran.com` loads; the browser console shows no CSP
   errors.
4. **Sign in with GitHub** returns to galley signed in.
5. Open the paper repository, edit a file, **Save**: a commit on
   `galley/<login>` and a pull request appear on GitHub.
6. Revoke the app under your GitHub Settings > Applications; galley asks you
   to sign in again (webhook delivered: check the app's Advanced tab).

Open question to test live: does a token refreshed with `repository_id` stay
scoped to that repository? GitHub documents the parameter but not whether
refresh keeps it. To check, install the app on a second test repository, take
the `access_token` that galley's `POST /api/galley/auth/token` returns for the
paper repo (browser devtools, Network tab), then:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/user/installations/<installation_id>/repositories
```

If the second repository is listed, or
`GET /repos/<owner>/<second-repo>/contents/` succeeds with that token, the
scope is not kept; record the result in `odd/tasks/galley-mvp.md`.

## Rollback and key rotation

- **Backup** before every upgrade: Settings > Backups in the admin UI, or stop
  the service and archive the `galley_pb_data` volume.
- **Rollback**: `git checkout <previous commit>` in `~/galley`, then
  `docker compose up -d --build` in `deploy/`. Restore the backup if a newer
  migration ran. Frontend: re-run the Pages workflow on the previous commit.
- **`GALLEY_TOKEN_KEY`**: change it in `.env` and `docker compose up -d`.
  Stored refresh tokens can no longer be decrypted and are deleted on use,
  so everyone signs in again. That is expected.
- **`GALLEY_GITHUB_CLIENT_SECRET`**: generate a new one in the app, update
  `.env`, restart, then delete the old one.
- **`GALLEY_WEBHOOK_SECRET`**: update the app and `.env` together; deliveries
  in between fail and can be redelivered from the app's Advanced tab.
- **`PB_ENCRYPTION_KEY`**: do not lose it; PocketBase settings in `pb_data`
  are encrypted with it. Rotation is not covered here **[unverified]**.
