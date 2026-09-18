// Prints SQL that imports a Substack subscriber export as active subscribers.
// Usage: node scripts/import-substack.mjs email_list.csv > import.sql
//        npx wrangler d1 execute DB --remote --file import.sql
import { readFileSync } from "node:fs";

const [header, ...rows] = readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/);
const cols = header.split(",");
const col = (row, name) => row.split(",")[cols.indexOf(name)]; // ponytail: Substack's export has no quoted fields
const q = (s) => `'${s.replaceAll("'", "''")}'`;

for (const row of rows) {
  if (col(row, "email_disabled") === "true") continue; // already not receiving mail on Substack
  const email = col(row, "email").trim().toLowerCase();
  const consentAt = Date.parse(col(row, "created_at"));
  console.log(
    `INSERT INTO subscribers (email, token, status, consent_at, consent_source) ` +
      `VALUES (${q(email)}, ${q(crypto.randomUUID())}, 'active', ${consentAt}, 'substack-import') ON CONFLICT (email) DO NOTHING;`,
  );
}
