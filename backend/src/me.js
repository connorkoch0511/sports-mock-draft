// backend/src/me.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { responder } = require("./lib/http");
const { subOf, ANON } = require("./lib/owner");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Matches the 50-entry cap on both browser registries, so a legitimate claim
// always fits and anything larger is not one of ours.
const MAX_IDS = 50;
const MAX_ID_LENGTH = 64;

function parseBody(event) {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    const isObject =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    return isObject ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_IDS) return undefined;
  const ids = value.filter(
    (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH
  );
  // De-duplicated: the same id twice would be one claim and one "skipped",
  // which reads as a failure that did not happen.
  return [...new Set(ids)];
}

/**
 * Take ownership of one item, if and only if nobody has it.
 *
 * The condition is the whole security property: the write is what decides,
 * not a read before it, so two people claiming the same id at the same moment
 * cannot both win. `ANON` is here because boards.js wrote that literal as a
 * placeholder owner before this phase.
 */
async function claimOne(table, key, sub) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: "SET ownerId = :me",
        ConditionExpression:
          "attribute_exists(#pk) AND (attribute_not_exists(ownerId) OR ownerId = :anon)",
        ExpressionAttributeNames: { "#pk": Object.keys(key)[0] },
        ExpressionAttributeValues: { ":me": sub, ":anon": ANON },
      })
    );
    return true;
  } catch (e) {
    // Already owned, or gone. Either way this claim took nothing, and the
    // caller is told exactly that.
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

async function claimAll(table, ids, keyFor, sub) {
  const results = await Promise.all(
    ids.map((id) => claimOne(table, keyFor(id), sub))
  );
  return {
    claimed: ids.filter((_, i) => results[i]),
    skipped: ids.filter((_, i) => !results[i]),
  };
}

exports.handler = async (event) => {
  const json = responder(event);
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || event.requestContext?.http?.path || "";

  if (method === "OPTIONS") return json(200, {});

  const sub = subOf(event);
  if (!sub) return json(401, { error: "Sign in required" });

  try {
    if (method === "POST" && path.endsWith("/claim")) {
      const body = parseBody(event);
      if (body === undefined) return json(400, { error: "Invalid JSON body" });

      const draftIds = validIds(body.draftIds);
      const boardIds = validIds(body.boardIds);
      if (draftIds === undefined || boardIds === undefined) {
        return json(400, {
          error: `draftIds and boardIds must be arrays of at most ${MAX_IDS} ids`,
        });
      }

      const drafts = await claimAll(
        process.env.DRAFTS_TABLE,
        draftIds,
        (draftId) => ({ draftId }),
        sub
      );
      const boards = await claimAll(
        process.env.BOARDS_TABLE,
        boardIds,
        (boardId) => ({ boardId }),
        sub
      );

      return json(200, {
        claimed: { drafts: drafts.claimed, boards: boards.claimed },
        skipped: { drafts: drafts.skipped, boards: boards.skipped },
      });
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
