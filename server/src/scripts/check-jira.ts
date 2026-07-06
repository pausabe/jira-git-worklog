import { loadEnv } from '../env.js';
import { JiraClient } from '../clients/jira.js';

// Quick smoke test for Jira credentials: `npm run check:jira`
async function main() {
  const env = loadEnv();
  const jira = new JiraClient(env);
  const me = await jira.getMyself();
  console.log('OK - Jira credentials are valid.');
  console.log(`  accountId:   ${me.accountId}`);
  console.log(`  displayName: ${me.displayName}`);
  console.log(`  timeZone:    ${me.timeZone ?? '(n/a)'}`);
}

main().catch((err) => {
  console.error('FAILED - could not authenticate against Jira.');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
