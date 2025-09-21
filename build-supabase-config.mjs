// build-supabase-config.mjs
import { writeFileSync } from 'node:fs';

const url = process.env.SUPABASE_URL || "https://ktrkuylwcoopfimhzdeu.supabase.co";
const key = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0cmt1eWx3Y29vcGZpbWh6ZGV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0OTAxOTcsImV4cCI6MjA3NDA2NjE5N30.qZVCDQsVrAiLACwztejFl25dKTFZc14B6YuwWlKI2C4";

if(!url || !key){
  console.warn("WARNING: SUPABASE_URL or SUPABASE_ANON_KEY missing. Falling back to local-only mode.");
}

const content = `export const SUPABASE_URL = "${url}";\nexport const SUPABASE_ANON_KEY = "${key}";\n`;
writeFileSync('supabase.config.js', content);
console.log("Generated supabase.config.js");
