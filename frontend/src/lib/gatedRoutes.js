/**
 * Should this route render, wait, or ask the visitor to sign in?
 *
 * "wait" exists because AuthProvider resolves the stored session
 * asynchronously: without it a signed-in user sees the sign-in prompt flash on
 * every single page load, which reads as being logged out at random.
 */
export function gateState({ configured, signedIn, loading } = {}) {
  if (!configured) return "allow";
  if (loading) return "wait";
  return signedIn ? "allow" : "prompt";
}
