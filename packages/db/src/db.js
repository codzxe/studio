import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
export function createDb(databaseUrl, options) {
    const client = postgres(databaseUrl, { max: 10, ...options });
    return drizzle(client, { schema });
}
//# sourceMappingURL=db.js.map