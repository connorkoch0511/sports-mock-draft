// Which drafts a person is in.
//
// seats already says this, but seats is a list and a DynamoDB index cannot be
// built on a list, so membership gets its own rows. They are a convenience for
// listing and nothing more -- reading a draft is gated on the seat, never on a
// row here, so the two disagreeing shows a draft that 404s rather than letting
// somebody in.

const { PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

async function addMember(ddb, TableName, sub, draftId) {
  await ddb.send(new PutCommand({ TableName, Item: { sub, draftId, joinedAt: Date.now() } }));
}

async function listDraftIds(ddb, TableName, sub) {
  const ids = [];
  let ExclusiveStartKey;
  // Paged for the same reason me.js pages its own query: a page is 1MB, and a
  // surprise here silently truncates somebody's list.
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: "#s = :me",
        ExpressionAttributeNames: { "#s": "sub" },
        ExpressionAttributeValues: { ":me": sub },
        ExclusiveStartKey,
      })
    );
    ids.push(...(res.Items || []).map((i) => i.draftId));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}

module.exports = { addMember, listDraftIds };
