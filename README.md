# Amber Electric Dashboard

This is my own custom dashboard for displaying energy price foreccasts from electricity retailer [Amber Electric](https://www.amber.com.au/).

The dashboard is intended to be run full time on a tablet, hung on a wall, and so is designed to be easily understood from a distance.


## Use

This fork runs on our own k3s clusters (see [Deployment](#deployment)). The Amber API key is held by the
server, so there's nothing to enter on the tablet: open the URL and it shows prices.


## Reading the dashboard

The banner at the top answers "should I use power right now?" with one word and a colour. With solar,
power you make yourself is close to free (you only give up the small feed-in credit), so the colours
follow the sun:

| Light     | Colour | When                                          | Meaning                                                |
|-----------|--------|-----------------------------------------------|--------------------------------------------------------|
| **FREE**  | green  | Sun's up: the panels usually cover the house  | Do the big jobs now: washing, dryer, oven, charging.   |
| **OK**    | blue   | Low sun: early morning, early evening         | Small jobs are fine; save big ones for green.          |
| **WAIT**  | amber  | No sun: paying for grid power                 | Everyday use is fine; leave big jobs for green.        |
| **AVOID** | red    | Amber rates the price high (any time of day)  | Expensive. No long oven/stove cooking, dryer, heaters. |
| **OFF**   | spike  | Price spike (or above the spike threshold)    | Very expensive. Switch off everything you can.         |

"Sun's up" is learnt from the house's own meter, not sunrise times: over the last two weeks, the
half-hours that exported more than they imported on at least half the days are green, and the
half-hours either side that did on at least a quarter of days are blue. It follows the seasons and the
panels on its own, but not today's weather. The sun only makes it green while the grid price is also
low (Amber's low or cheaper); at a dearer price, e.g. a peak tariff starting mid-afternoon, a big load
that outruns the panels costs real money, so sun shows blue and low sun amber. A negative price is
always green. Until there are 5 days of
meter data it falls back to Amber's own rating (green for low prices, amber for neutral).

The right of the banner shows when free ends, or when the next free period starts.
In the settings you can optionally override all this with your own cents thresholds
("always green at or below", "always red at or above").


## Deployment

```
public/                  the site (flat: one ConfigMap can't hold subdirectories)
nginx/                   nginx config: static files + the /api/prices proxy to Amber
deploy/
  k8s/base, overlays/    Deployment, Service, Ingress (dev/prod hosts); image pinned by digest
  deploy.sh              what CI runs: builds content-hashed ConfigMaps, applies, waits, prunes
  create-secret.sh       one-off, by an admin: stores the Amber API key in-cluster
  cluster/               admin-owned extras CI can't apply (NetworkPolicy)
.github/workflows/       deploy (dev, then gated prod), validate, digestabot
Dockerfile               local preview only
```

The clusters run the stock, digest-pinned Chainguard nginx image
(`fastcast-dev.self-hosted.io/cgr/nginx:1.31@sha256:…`) with `public/` and `nginx/` mounted from
ConfigMaps, the same pattern as `chainguard-demos`. No image is built or pushed. Each deploy creates
ConfigMaps named by a hash of their content, so any change rolls the pod, a bad config never touches
the running pod, and `kubectl rollout undo` still works.

### How the API key is kept secret

The browser never sees the Amber API key. The page calls `/api/prices` and `/api/usage` on its own
server, and nginx forwards those to Amber, adding the key and site id from the `amber-dashboard-api`
Secret (mounted read-only at `/etc/nginx/amber/amber.conf`). `/api/usage` only accepts fixed weeks
within one calendar month (Amber serves at most 7 days per request; the page adds them up for the
"Usage cost this month" bar), so anyone who can load the page can see this household's
metered usage month by month (up to Amber's 90 days back). Nothing else the key can read (site/NMI
details) is reachable through the proxy. Prices are cached for 30 seconds and usage for 10 minutes,
all rate-limited, so however many tablets (or strangers) load the page, Amber sees about one call a minute.

The key exists in exactly one place: that Secret. Not in git, not in GitHub secrets, not in the image,
not on the tablet. Create or rotate it with:

```sh
deploy/create-secret.sh k3s-dev     # prompts for the key (hidden), finds the site id, restarts the pod
deploy/create-secret.sh k3s-prod
```

Until the Secret exists the dashboard deploys fine and shows "no API key set up yet".

### Pipeline

| Workflow | Runs on | What it does |
|---|---|---|
| `deploy.yml` (+ `.github/actions/k8s-deploy`) | push to `main` (deployed paths) | dev on `deployments-dev`, then prod on `deployments-prod` behind the `prod` environment's approval |
| `validate.yml` | PRs (same-repo only) and `main` | manifests render, every image is digest-pinned, no Amber key committed |
| `digestabot.yml` | hourly | PR to bump the nginx digest; merging it deploys it |

Hardening: `permissions: {}` at the top level with jobs opting into `contents: read`; every action is
a Chainguard hardened mirror pinned to a full commit SHA; `persist-credentials: false`; only `main`
deploys; each job declares its environment and gets only that environment's kubeconfig; the kubeconfig is
written to `RUNNER_TEMP` (mode 600) and deleted at the end; no `${{ }}` inside `run:` scripts; fork PRs
never run on the in-cluster runners.

### One-time setup

1. **Repo location.** The ARC runners are registered to the `fastcast-dev` org, so the repo lives at
   `fastcast-dev/amber-dashboard`. *(done)* Actions there are limited to `chainguard-actions/*` and
   `chainguard-dev/*`, must be SHA-pinned, and outside contributors' runs need approval.
2. **Environments** `dev` and `prod`, both deploying from `main` only; `prod` needs a reviewer's
   approval. *(done)*
3. **Cluster credentials**: an environment secret `KUBECONFIG` on each environment, so the prod token
   is only released after approval:
   ```sh
   deploy/set-github-kubeconfig.sh dev k3s-dev
   deploy/set-github-kubeconfig.sh prod k3s-prod
   ```
   *(done)*
4. **digestabot.** Repo variable `CHAINGUARD_IDENTITY`: a Chainguard assumable identity bound to this
   repo's `main` (the chainguard-demos one is bound to that repo):
   ```sh
   chainctl auth login
   chainctl iam identities create github amber-dashboard-digestabot \
     --github-repo=fastcast-dev/amber-dashboard --github-ref=refs/heads/main \
     --parent=max.bern --role=registry.pull
   gh variable set CHAINGUARD_IDENTITY --repo fastcast-dev/amber-dashboard --body '<id printed above>'
   ```
   The repo's Actions allowlist also names the three non-Chainguard actions digestabot runs internally
   (`actions/github-script`, `actions/upload-artifact`, `sigstore/cosign-installer`) by commit SHA.
   When the digestabot pin in `digestabot.yml` changes, update those from its `action.yml`.
   "Allow GitHub Actions to create and approve pull requests" is on so it can open its PR. *(done)*
5. **k3s-deploys** (admin, not CI):
   - edge routers + Cloudflare DNS in `ansible/inventory/traefik.yml` for
     `amber-dashboard-dev.self-hosted.io` → `k3s-dev-svc` and `amber-dashboard.self-hosted.io` →
     `k3s-prod-svc`, with `crowdsec-bouncer` and **an IP allowlist for home** (the page is read-only,
     but there's no reason for it to be public)
   - when the `public` namespace NetworkPolicies are switched back on, add
     [`deploy/cluster/networkpolicy.yaml`](deploy/cluster/networkpolicy.yaml) (nginx needs HTTPS out to Amber)
6. **The Secret**: `deploy/create-secret.sh k3s-dev` and `deploy/create-secret.sh k3s-prod`.

### Local preview

```sh
cp deploy/amber.conf.example amber.conf   # fill in; gitignored
docker build -t amber-dashboard .
docker run --rm -p 8080:8080 -v "$PWD/amber.conf:/etc/nginx/amber/amber.conf:ro" amber-dashboard
```

### Tablet setup

1. Open the dashboard's HTTPS address in Chrome (84 or newer).
2. Chrome menu > **Install app** (or **Add to Home screen**). The installed app opens full screen,
   stays full screen when the page reloads, and still loads from cache if the server is briefly down.
   (Without installing, tap anywhere on the dashboard to go full screen.)
3. Keep the tablet on its charger. The page keeps the screen awake while it's open; Android
   **Developer options > Stay awake** is a good backup.

Notes:
* Alert sounds only work after the page has been tapped once since it loaded (a Chrome rule).
* The page reloads itself once a day to pick up new versions (except in tap-to-full-screen mode, which a reload would exit).
* If prices can't be loaded for 5 minutes, a grey bar across the top says they may be out of date.


## Implementation

The dashboard uses the [Amber API](https://github.com/amberelectric/public-api/discussions), through which Amber customers gain get access their own data.

The app is built as a simple, one-page [Vue.js](https://vuejs.org/) app.
(See [public/index.html](public/index.html) and [public/app.js](public/app.js))


## Screenshot

<img width="1488" alt="image" src="https://user-images.githubusercontent.com/754403/167063406-28e148d1-d581-4aa1-96ed-08a98890a574.png">
