// build-supabase-config.mjs
import { writeFileSync } from "fs";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables");
  process.exit(1);
}

const content = `export const SUPABASE_URL = "${url}";
export const SUPABASE_ANON_KEY = "${key}";
`;

writeFileSync("supabase.config.js", content);

console.log("✅ supabase.config.js generated");
