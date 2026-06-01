/** One-time backfill: seed built-in roles + assign roleIds for every existing org. */
import { db } from '../src/db/client.js';
import { organizations } from '../src/db/schema.js';
import { setupOrgRoles } from '../src/lib/roleSeed.js';

const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
for (const org of orgs) {
  await setupOrgRoles(org.id);
  console.log(`✓ roles seeded + backfilled for org ${org.name} (${org.id})`);
}
console.log(`Done. ${orgs.length} org(s) processed.`);
process.exit(0);
