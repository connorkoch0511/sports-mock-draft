// backend/scripts/purge-unowned.js
//
// One-off: delete every draft and board that nobody owns, after dumping them
// to a file. Run once, against production, BEFORE the read gate ships --
// afterwards these rows are unreachable and the dump is the only way back.
//
// Refuses to delete anything without --confirm, so a curious run is a dry run.
//
// Lives under src/ rather than backend/scripts/ for one blunt reason: the AWS
// SDK is vendored at backend/src/node_modules, and a sibling directory cannot
// resolve a bare specifier into it. The alternatives were a second vendored
// copy of the SDK (~15MB, committed) or a relative require reaching into
// another directory's node_modules. It rides along in the Lambda bundle at a
// few KB and nothing imports it there.
const fs = require("node:fs");
const path = require("node:path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { ANON } = require("../lib/owner");

const TABLES = [
  { name: "perfectpick-drafts", key: "draftId" },
  { name: "perfectpick-boards", key: "boardId" },
];

/** Nobody owns this: no ownerId, an empty one, or the legacy placeholder. */
function isPurgeable(item) {
  const owner = item?.ownerId;
  return !owner || owner === ANON;
}

async function scanAll(ddb, TableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const outDir = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : path.join(require("node:os").homedir(), "perfectpick-purge-backups");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(outDir, { recursive: true });

  for (const { name, key } of TABLES) {
    const all = await scanAll(ddb, name);
    const doomed = all.filter(isPurgeable);
    console.log(`${name}: ${all.length} rows, ${doomed.length} unowned`);

    if (doomed.length === 0) continue;

    const dump = path.join(outDir, `${name}-${stamp}.json`);
    fs.writeFileSync(dump, JSON.stringify(doomed, null, 2));
    // Read it back before deleting anything: a dump that did not land is the
    // difference between a cleanup and a data loss.
    const readBack = JSON.parse(fs.readFileSync(dump, "utf8"));
    if (readBack.length !== doomed.length) {
      throw new Error(`dump verification failed for ${name}`);
    }
    console.log(`  dumped ${readBack.length} rows to ${dump}`);

    if (!confirm) {
      console.log("  dry run -- pass --confirm to delete");
      continue;
    }
    for (const item of doomed) {
      await ddb.send(new DeleteCommand({ TableName: name, Key: { [key]: item[key] } }));
    }
    console.log(`  deleted ${doomed.length} rows`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { isPurgeable };
