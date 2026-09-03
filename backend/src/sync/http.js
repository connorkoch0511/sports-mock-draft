// One timeout, shared by every outbound fetch in the sync.
// Lambda's own 60s Timeout (template.yaml) -- so a fetch with no AbortSignal
// can hang well past the point the invocation is killed. 10s leaves
// comfortable room inside the 60s budget for everything that runs around a
// given call (the other three fetches below, plus the DynamoDB batch write),
// while still being far longer than any of these endpoints take to answer
// under normal conditions. Shared by every outbound fetch in this file so a
// stall anywhere degrades to an error quickly instead of burning the whole
// invocation.
const FETCH_TIMEOUT_MS = 10_000;

module.exports = { FETCH_TIMEOUT_MS };
