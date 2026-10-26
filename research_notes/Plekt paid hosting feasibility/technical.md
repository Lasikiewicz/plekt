# Paid hosting feasibility: technical research

Research date: 21 October 2026. Operating assumption: a UK-based individual or small company sells a low-cost managed Plekt instance to each customer. This note assesses technical and licensing readiness, not legal/tax advice. Local citations refer to the current workspace; external sources were accessed 21 October 2026.

## Is the current application architecture suitable for hosted customer accounts?

### Takeaway

Plekt can be hosted as a managed service most naturally as one isolated application/container and persistent local volume per customer. The app already supports container operation, guided first-run claim, HTTPS reverse-proxy deployment, encrypted provider credentials and backup/restore. It is not a multi-tenant service: one administrator identity and one SQLite database/configuration form one installation. Avoid sharing one process/database among paying users; build a provisioning/control plane around isolated instances only after operational and security gaps are closed.

### Cited Findings

- Plekt is one long-running Node process serving SPA, API and an in-process per-minute scheduler; state is local SQLite plus media directory. There is no external DB/cloud-function/production tier ([architecture.md](../../docs/architecture.md), lines 7–19).
- Auth is explicitly “Local single-admin”; account claim is atomic and the setup wizard is resumable ([auth.md](../../docs/auth.md), lines 1–5, 30–48; [onboarding.md](../../docs/onboarding.md), lines 7–34). This gives a good one-customer onboarding base, but no organization/multi-user/tenant boundary is described.
- The Docker image uses a non-root `plekt` user, `/data` volume, and port 5055; default compose publishes 5056 and binds `./data` ([Dockerfile](../../Dockerfile), lines 35–47; [docker-compose.yml](../../docker-compose.yml), service `plekt`). Secure overlay adds read-only root, tmpfs, no-new-privileges and required secrets ([docker-compose.secure.yml](../../docker-compose.secure.yml), lines 17–31).
- Provider tokens are encrypted AES-256-GCM; the key is separately stored/generated and not included in database/application backups. Restoring encrypted credentials requires the original `credential.key` or pinned `PLEKT_CREDENTIAL_KEY` ([auth.md](../../docs/auth.md), “Provider credentials”; [credentialVault.js](../../server/src/utils/credentialVault.js), line 45).
- Full backups cover portable collections but not media cache; plain JSON export/import also exists. The operator must include `data/media/` separately if cache preservation matters ([backups.md](../../docs/backups.md), lines 11–16). SQLite WAL on NFS/SMB/clustered volumes or separate hosts is expressly unsupported; split roles can share only same-host local storage ([hardening.md](../../docs/hardening.md), lines 178–185).
- AGPL-3.0 permits charging for copies/support (LICENSE.md §4, lines 145–157); this supports charging for managed hosting. GNU’s official §13 says operators of a *modified* network-accessible version must prominently offer users the modified version’s corresponding source at no charge ([GNU AGPL text](https://www.gnu.org/licenses/agpl-3.0.en.html), accessed 2026-10-21). The local UI’s visible source/license notice and precise hosted-build source offer were not established by the docs inspected; verify implementation and third-party dependency notices before launch.

### Inferences

- **Recommended MVP topology:** control plane/provisioner separate from tenant data plane; one container/VM, one local SSD-backed `/data`, one DNS name/TLS endpoint, unique generated secrets, and explicit backup/restore lifecycle per customer. No tenant should be able to address another tenant’s filesystem, DB, config, logs, credentials or webhook secret. If using one host, enforce per-container resource limits, network policy, independent credentials, and host-level backup isolation. Compose’s current resource cap is a development hardening example, not a full multi-tenant boundary.
- Keep support access exceptional, logged, time-limited and consent-based. Do not make provider passwords/API tokens visible to the operator. Design account deletion/export and suspension/retention behavior before billing.
- Ship exact source/build provenance per running release and a conspicuous in-app source link (where required); ensure support/marketing claims distinguish hosted support from guarantees of data durability.

### Gaps

- No product-grade tenant provisioning/billing, per-customer monitoring, quota enforcement, lifecycle automation, support-access controls, deletion/export SLA, uptime objective, incident response, or operator runbook was found in inspected docs.
- No confirmed customer-scale density/cost benchmark or restore-time objective. Container limits in secure compose do not show that memory/CPU/storage thresholds are safe for hosted tenants.
- Licensing interpretation around unmodified hosting and AGPL section 13 is fact-sensitive; obtain counsel’s written view and confirm all contributors/third-party components and UI notice obligations. This note is not a legal conclusion.

## How can hosted Plekt reach customers’ media servers safely and reliably?

### Takeaway

A hosted instance’s hardest product constraint is network direction. Native Plex/Emby/Jellyfin webhooks expect inbound reachability to Plekt, while many customer media servers sit behind NAT/firewalls. The first pilot should require a customer-configured, publicly reachable HTTPS endpoint or VPN/tunnel and explicitly exclude unsupported networks; a customer-side outbound connector is the better scale path, but requires new authenticated protocol, lifecycle and security design.

### Cited Findings

- Plekt’s webhook guide configures media-server POSTs to `https://<plekt-host>/api/webhook?token=...` (or secret header) ([webhooks.md](../../docs/webhooks.md), lines 21–41). Therefore, absent a relay/tunnel, the media server must resolve and reach the hosted endpoint.
- Existing docs recommend TLS termination at reverse proxy and `COOKIE_SECURE=true` when exposed to the internet ([hardening.md](../../docs/hardening.md), “HTTPS and reverse proxy”; [security-checklist.md](../../docs/security-checklist.md), lines 48–54). The webhook query token authorizes watch-history writes and must be treated as a credential ([hardening.md](../../docs/hardening.md), lines 125–129).
- Server-side outbound requests deliberately allow private/LAN addresses because media servers commonly live there, while blocking selected cloud metadata names, URL credentials, unsafe schemes and revalidated redirect targets ([outbound.js](../../server/src/utils/outbound.js), lines 88–128, 134–171; [security-checklist.md](../../docs/security-checklist.md), lines 17–29).

### Inferences

- **Pilot connectivity option A (simplest):** provision a dedicated public HTTPS hostname per tenant; customer configures webhooks to it and configures outbound connections from Plekt to Plex/Emby/Jellyfin only if those targets are also routable from the hosting network. This will not work for many LAN-only services and requires careful customer firewall guidance; do not promise universal compatibility.
- **Option B (recommended product direction):** a small customer-side connector establishes an outbound authenticated TLS/WebSocket or long-poll channel and relays events/commands to the hosted tenant. This avoids inbound port-forwarding at customer premises and can make LAN-only service discovery possible locally. Treat it as an independent security-sensitive component: short-lived enrollment, tenant-bound device identity, rotating/revocable credentials, narrow command allowlist, replay protection, signed/validated messages, bounded queues, explicit reconnect/offline status, and no arbitrary URL/command relay. Model command authorization as equivalent to granting the hosted service access to the customer’s media server.
- SSRF is a first-class concern: hosted user-controlled server URLs that can access arbitrary RFC1918/loopback targets enable attacks against other tenants and hosting control planes. Existing policy intentionally allows LAN and localhost, suitable to self-host but unsafe as a public service boundary. Connector mode should reduce host-side reachability; tenant network isolation and strict egress policy should prevent lateral access. Revisit redirect/DNS rebinding and IPv4/IPv6 destination validation at the boundary.
- Credential risks include encrypted-at-rest tokens, but shared-host compromise exposes all mounted per-tenant keys/data; key isolation, least privilege, encrypted backups and a tested rotation path matter. Never include `.env`, secrets or raw provider credentials in logs/support exports.
- Scheduler runs in-process each minute ([architecture.md](../../docs/architecture.md), lines 7–19). Per-tenant process isolation avoids cross-tenant scheduler state and SQLite contention, but scheduler load, outbound API budgets, stuck work, clock drift, duplicate execution after restart and tenant quotas need measurement/limits.

### Gaps

- No connector/agent, tenant-scoped egress proxy, customer network reachability test, webhook delivery status/SLO, or remote support access mechanism was identified.
- Exact third-party platform webhook retry/timeout behavior and customer ISP/firewall compatibility need a practical compatibility matrix; this desk review did not validate live systems.
- Existing URL validation is not a hosted multi-tenant SSRF defense: static source review indicates broad private-network allowance. Security review should examine DNS resolution/rebinding, IPv6, redirects, user URL entry points, and host/provider credential exposure before public pilot.

## What is missing before a paid pilot, and how should readiness be measured?

### Takeaway

Run a small, invitation-only pilot only after isolating tenants, implementing recoverable operations and testing network/restore/security behavior. A small fee does not remove UK data-protection and consumer/business obligations. Treat watch histories, provider identifiers and connection tokens as personal data; map roles and subprocessors, document processing and retention, and obtain UK professional advice on terms, privacy, data protection fee and tax.

### Cited Findings

- ICO guidance says an organisation processing personal data on behalf of another is a processor; written contracts must stipulate Article 32 security measures and make compliance evidence available ([ICO, A guide to data security](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/security/a-guide-to-data-security/), accessed 2026-10-21). ICO processor-contract guidance covers instructions, security, subprocessors, rights assistance, end-of-contract provisions and audits ([ICO contracts and liabilities](https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/data-protection-fee-faqs/), accessed 2026-10-21; contract guide: [ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/), accessed 2026-10-21). Whether the operator is controller or processor depends on actual purposes and means, not the label.
- ICO states controllers must pay a data protection fee unless an exemption applies; fees range by size/turnover ([ICO fee FAQ](https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/data-protection-fee-faqs/), accessed 2026-10-21). Check applicability directly rather than assume exemption.
- HMRC’s current VAT threshold is £90,000 taxable turnover; mandatory registration can also arise when expected to exceed it in the next 30 days ([GOV.UK VAT registration](https://www.gov.uk/register-for-vat), accessed 2026-10-21). Actual treatment depends on the operator’s taxable supplies and circumstances.
- Operationally, current hardening checklist calls for unique admin and system secrets, HTTPS, private webhook URLs, persistent `/data` and verified local/remote backup recovery ([security-checklist.md](../../docs/security-checklist.md), lines 48–54). Existing backup docs warn credential key is separate; restore must account for it ([auth.md](../../docs/auth.md), “Provider credentials”).

### Inferences

- **Pre-pilot gates:** (1) per-customer isolated runtime and storage, no shared secrets, enforce CPU/memory/disk and rate limits; (2) infrastructure secrets manager and tenant key hierarchy; (3) TLS, strict host routing, secure cookies, abuse/rate controls, dependency/image patch process, least-privilege host and egress firewall; (4) tested automated encrypted backups including database, config, credential key and media policy, immutable/off-host copy and restore drills; (5) operator alerting for availability, disk, memory, scheduler lag, backup failure, certificate expiry and outbound error; (6) written incident, breach, deletion, export, suspension, billing-failure and support runbooks; (7) privacy notice, terms, processing terms/subprocessor list, retention/deletion schedule and data-location disclosure; (8) cost model that includes support and backups, not only compute.
- Avoid a “cheap unlimited” offer. Begin with one clearly scoped plan, a capped number of connected services/library scale or a fair-use policy, defined retention and support hours. Price is an estimate to be derived from measured per-tenant compute/storage/network/support costs; public cloud price estimates were not researched because provider/location choice is unspecified.
- **Measurable pilot tests (proposed acceptance criteria, not existing results):** deploy 5–10 consenting tenants for 30 days; 100% tenant boundary checks across API, filesystem, backups and logs; zero cross-tenant credential/data access; at least 99% service availability excluding announced maintenance; at least 99% webhook receipt when customer endpoint is reachable; scheduler delay p95 under 2 minutes; alert within 5 minutes on failed backup/disk threshold; restore a randomly selected tenant within a published RTO (initial target 4 hours) and RPO (24 hours); verify restored provider connections only when key is present; successful customer data export and deletion within 7 days; zero unresolved critical/high findings from independent security review. For connector MVP, additionally test revocation, offline/reconnect, replay/forged messages, malicious URLs, and no arbitrary network reachability.

### Gaps

- No hosting region/provider, business entity, customer countries, billing/tax model, price target, support capacity, retention period, availability commitment or pilot count is specified; these materially change economics and obligations.
- Legal characterization (controller/processor), UK GDPR lawful basis/roles, consumer cancellation/refund terms, VAT treatment and ICO fee exemption require current facts and professional advice. ICO says its contracts guidance is under review following the Data (Use and Access) Act, so re-check before launch ([ICO contracts guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/), accessed 2026-10-21).
- The pilot criteria above are proposed engineering thresholds for discussion, not externally sourced standards or promises; validate against the chosen infrastructure and customer needs before publication.
