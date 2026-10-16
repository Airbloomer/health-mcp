const allowed = new Set(["INGEST_TOKEN_HASH", "MCP_READ_TOKEN_HASH"]);
const name = process.argv[2];
if (!allowed.has(name)) {
  console.error("secret name is not allowed for a tenant worker");
  process.exit(1);
}
console.error("not implemented");
process.exit(1);
