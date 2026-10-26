# Plekt paid hosting feasibility and economics

Research date: 21 October 2026. Assumption: the operator is based in the UK and initially sells primarily to UK customers. Prices and provider policies below are those shown by primary sources at research time; cloud prices can change. This is decision support, not tax or legal advice.

## Hosting options for long-running isolated Node + SQLite instances

### Takeaway

A single managed VPS with containers and customer-specific persistent volumes is the most plausible low-cost pilot: it gives control over Docker, filesystem persistence, SQLite, backup scheduling, and tenant isolation. Hetzner has the clearest low-cost price point; DigitalOcean costs more but offers a straightforward, better documented managed cloud product. Render is operationally simpler but per-service compute, persistent disk, workspace and bandwidth charges likely make it a poor fit for very low monthly prices unless each customer shares a service (which weakens isolation).

### Cited Findings

- Plekt currently runs as one long-lived Node.js process serving UI, API and in-process scheduler; state lives in a local SQLite database and local media folder. It has no external database or separate production environment. This makes persistent local storage, safe SQLite lifecycle, per-customer process/config isolation and restore procedures central requirements. — [Repository architecture](https://github.com/plekt/plekt/blob/develop/docs/architecture.md) (repository doc; read locally 21 October 2026)
- Hetzner's June 2026 cloud price update lists EU prices excluding VAT. In Germany/Finland, cost-optimised CX23 is €5.49/month and CX33 €8.49; regular-performance CPX22 is €19.49. The pricing page identifies the cost-optimised class as suited to low/medium traffic and variable CPU workloads. — [Hetzner June 2026 price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [cost-optimised cloud](https://www.hetzner.com/cloud/cost-optimized/)
- Hetzner separates primary IP charges from compute; a cloud primary IPv4 is €0.50/month, IPv6 is free. Its price adjustment page lists prices excluding VAT. — [Hetzner IP pricing](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/), [Hetzner cloud pricing update](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- DigitalOcean Basic Droplets list $6/month for 1 GiB RAM/1 vCPU/25 GiB SSD/1,000 GiB transfer, $12 for 2 GiB/1 vCPU/50 GiB/2,000 GiB, and $18 for 2 GiB/2 vCPU/60 GiB/3,000 GiB. Inbound transfer is free; included outbound transfer depends on plan, with overage rules on the provider's page. It describes support for Node.js applications and databases. — [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- Render supports Docker services and persistent disks; the pricing page lists persistent disk at $0.25/GB-month, with network transfer allowance varying by workspace tier and $0.15/GB beyond the included amount. Render bills compute, workspace plans and metered features. A single independently running service per customer can add compute costs per tenant. — [Render pricing](https://render.com/pricing), [Render persistent disks](https://render.com/docs/disks)
- Hetzner's 2026 price page and DigitalOcean's pricing page do not establish actual customer-per-host capacity. Neither should be translated into a customer count without measuring real Plekt idle/peak RAM, SQLite/media growth, sync workload and backup overhead.

### Inferences

- Recommended pilot: a single EU VPS, containerized per customer with a unique SQLite/media/config volume, reverse proxy/TLS, resource limits, and separately stored encrypted/off-host backups. Start with a small invited cohort (for example 5–10 tenants) and observe resource use over several weeks before increasing density. This cohort is a test scope, not a capacity claim.
- Prefer x86 architecture for the pilot unless Plekt's dependencies and image build are deliberately validated for ARM. Preserve per-tenant data ownership and provide a tested export/restore path; the current app has local and remote backup facilities, but an operator also needs platform-level recovery and account deletion/data export operations.
- Hetzner's low base cost may reduce infrastructure break-even risk, but the operator then owns host security updates, Docker hardening, monitoring, capacity, backups, disaster recovery, abuse handling and incident response. DigitalOcean has a higher but still predictable starting price; it is a reasonable operational comparison rather than an obvious price winner.
- Render can work for a managed pilot, but estimate the true per-customer service compute + disk + workspace + bandwidth total before setting price. Do not assume app traffic is the dominant network cost; Plex/Emby/Jellyfin integrations and metadata fetch patterns must be measured.

### Gaps

- No measured memory, CPU, SQLite/database size, media cache growth or network use per Plekt instance was found in the repository. No customer density is asserted.
- Need validate provider region options, VAT/invoice treatment for the specific business account, backups/volume pricing, service limits and terms before purchase.
- One-PaaS comparison here uses Render. Other platforms may be viable, but their current long-running process and persistent disk economics were not assessed.

## Unit economics at £3, £5 and £7 per customer/month

### Takeaway

At these prices, card processing's fixed 20p component is material, especially at £3. Before hosting, support, tax, refunds, failed payments or admin overhead, standard UK card charges leave about £2.76, £4.73 or £6.70 per paid customer/month respectively. The model supports a very small, tightly scoped service more readily at £5–£7; £3 leaves little room for human support.

### Cited Findings

- Stripe UK lists standard UK cards at 1.5% + 20p per successful transaction; premium UK cards are 2.8% + 20p, EEA cards 2.5% + 20p, and other international cards 3.15% + 20p (currency conversion can add 2%). Stripe also lists £20 received-dispute fee. — [Stripe UK pricing](https://stripe.com/gb/pricing)
- HMRC says a UK business must register for VAT when taxable turnover exceeds £90,000 over the last 12 months or is expected to exceed it in the next 30 days; voluntary registration below the threshold is possible. — [GOV.UK VAT registration](https://www.gov.uk/register-for-vat)
- HMRC states that digital services to UK consumers are liable to UK VAT, and cross-border consumer digital services may be taxable where the consumer is based. Whether hosted Plekt access is an electronically supplied service, or a managed service involving meaningful human intervention, and what cross-border rules apply should be confirmed with an accountant. — [GOV.UK digital services VAT](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers)

### Inferences

Illustrative monthly gross receipts and Stripe deductions below assume one successful standard UK card payment per customer, listed fee, no refunds/disputes, no VAT included/charged, and no tax/accounting or other payment costs. Net column is gross less estimated Stripe processing only.

| Customers | £3 plan: gross / net after Stripe | £5 plan: gross / net after Stripe | £7 plan: gross / net after Stripe |
|---:|---:|---:|---:|
| 10 | £30 / £27.55 | £50 / £47.25 | £70 / £66.95 |
| 25 | £75 / £68.88 | £125 / £118.13 | £175 / £167.38 |
| 50 | £150 / £137.75 | £250 / £236.25 | £350 / £334.75 |
| 100 | £300 / £275.50 | £500 / £472.50 | £700 / £669.50 |

- Revenue required just to cover one operator-hour valued at £20/hour (a modeling assumption, not a market wage) after standard card fees is roughly 8 customers at £3, 5 at £5, or 3 at £7. This is before infrastructure. At 10 minutes of monthly support per customer and £20/hour labor, support costs £3.33/customer, exceeding the £3 tier's post-fee revenue and consuming most of £5.
- VAT scenario matters. If the listed customer price includes 20% VAT once registered and VAT applies, a £5 VAT-inclusive price represents £4.17 before card fees; if prices are quoted plus VAT, customer checkout differs. The model must not treat the £90k registration threshold as permission to ignore cross-border obligations or other VAT rules.
- Annualised turnover for 100 customers is £3,600 / £6,000 / £8,400 at £3/£5/£7, well below £90,000 on this service alone, but threshold aggregation, other sales and statutory rules matter.

### Gaps

- No assurance that VAT classifies this exact offer as an electronically supplied service; confirm with UK tax adviser, especially for non-UK customers.
- Stripe charges depend on card type, payment method, currency and disputes. No payment recovery/churn or billing software costs included.
- Hosting and support costs cannot be translated into per-customer margin until pilot consumption and operator support time are measured.

## Operating model, backups, support break-even and pilot decision

### Takeaway

Treat this first as a managed hosting/support service, not passive SaaS. The safest first commercial test is a capped, invitation-only pilot with explicit limits (one instance/account, storage quota, supported integrations, backup/restore policy and response expectations), automated provisioning and a documented exit/export path. Set a price only after collecting per-tenant resource and support data; £5–£7 is a more credible starting test range than £3 if any hands-on help is included.

### Cited Findings

- Plekt's backup design has local watch-history backups, encrypted full backups and portable full export/import. Files under `data/` include DB, media and configuration/secrets; copying the directory is documented as a manual complete backup, while artwork/media binaries need separate handling in the portable backup formats. — [Repository backup documentation](https://github.com/plekt/plekt/blob/develop/docs/backups.md) (read locally 21 October 2026)
- Hetzner's cloud server documentation says backups and snapshots are available as features; operator must verify their current add-on pricing and restore characteristics. — [Hetzner cloud server overview](https://docs.hetzner.com/cloud/servers/overview/)
- DigitalOcean includes outbound transfer starting at 500 GiB/month and lists additional block storage via Volumes; storage and backup prices are separate product costs and should be checked against current account pricing. — [DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets)
- Render's pricing displays persistent disk and bandwidth as priced features; disk is $0.25/GB-month, and listed transfer overage is $0.15/GB after tier allowances. — [Render pricing](https://render.com/pricing)

### Inferences

- Backup design should include frequent SQLite-consistent snapshots or app-supported exports, encryption at rest and in transit, off-host copy, retention, restore drills and per-tenant deletion. Do not rely on a VM snapshot alone as proof of a recoverable SQLite database. The DB, local media, secrets/config and user export each need defined treatment.
- A VPS pilot can use one host initially, but it has a host-level failure domain. Keep backups outside that host/provider and define a recovery target before accepting ongoing payment. Operating just one host also means patching/rebooting causes possible service interruptions.
- Support-time break-even is more constraining than raw VM price. Under a £20/hour valuation assumption, each 10 minutes of support costs £3.33; if support averages 5 minutes/customer/month, cost is £1.67. At £3, every support request or onboarding touch quickly erodes gross margin. Publish what is included and provide self-service onboarding before scaling.
- Pilot decision gates: (1) deploy a small invited cohort on a single region/provider; (2) measure idle and peak RSS, CPU, DB/media disk growth, egress, failed jobs and backup size; (3) record every support contact and minutes spent; (4) run restore and tenant deletion drills; (5) review isolation/security and provider terms; (6) price only after the actual monthly cost/customer and support burden are known. These are recommendations, not existing measured results.

### Gaps

- Current app backup documents describe user-operated backup/restore, not a hosted operator control plane for tenant provisioning, metering, billing, suspension, restore, deletion or support access. Its readiness and implementation effort need engineering review outside this research.
- No measured pilot, operational support history, customer demand, payment conversion, churn or legal review exists in the material reviewed.
- Confirm UK consumer contract/cancellation, privacy, data protection, security incident, acceptable-use, and service-level obligations before taking payment; this note does not resolve those topics.

---

Sources accessed 21 October 2026. All figures are snapshots, exclude applicable taxes unless specified, and are not capacity promises.
