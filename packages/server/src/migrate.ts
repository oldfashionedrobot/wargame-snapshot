// The one thing that changes the schema: `bun run db:migrate`, which
// `bun run dev` runs before starting, and Fly's release_command, once per
// deploy before the running machine is replaced. The server never migrates.
// ⚠️ The production configuration is checked first, the same check the server
// makes, because this is the last point at which a missing secret stops a
// deploy with the old machine still serving.
import { checkProductionConfig } from './const';
import { createDb, migrate } from './db';

checkProductionConfig();
const database = await createDb();
await migrate(database);
database.db.$client.close();
console.log('migrations applied');
