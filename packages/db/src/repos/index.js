import { createAssetsRepo } from "./assets.js";
import { createAuditRepo } from "./audit.js";
import { createCommentsRepo } from "./comments.js";
import { createInvoicesRepo } from "./invoices.js";
import { createLeasesRepo } from "./leases.js";
import { createLedgerRepo } from "./ledger.js";
import { createPresenceRepo } from "./presence.js";
import { createProjectsRepo } from "./projects.js";
import { createRendersRepo } from "./renders.js";
import { createRunsRepo } from "./runs.js";
import { createSettingsRepo } from "./settings.js";
import { createShareTokensRepo } from "./share-tokens.js";
import { createSubscriptionsRepo } from "./subscriptions.js";
import { createThreadsRepo } from "./threads.js";
import { createVersionsRepo } from "./versions.js";
import { createWebhookEventsRepo } from "./webhook-events.js";
export function createRepos(db) {
    return {
        projects: createProjectsRepo(db),
        versions: createVersionsRepo(db),
        leases: createLeasesRepo(db),
        assets: createAssetsRepo(db),
        threads: createThreadsRepo(db),
        runs: createRunsRepo(db),
        ledger: createLedgerRepo(db),
        comments: createCommentsRepo(db),
        renders: createRendersRepo(db),
        audit: createAuditRepo(db),
        subscriptions: createSubscriptionsRepo(db),
        invoices: createInvoicesRepo(db),
        settings: createSettingsRepo(db),
        webhookEvents: createWebhookEventsRepo(db),
        shareTokens: createShareTokensRepo(db),
        presence: createPresenceRepo(db),
    };
}
//# sourceMappingURL=index.js.map