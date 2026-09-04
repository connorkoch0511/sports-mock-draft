/**
 * Should this action ask the user to sign in first?
 *
 * One rule, in one place, because "when is a button gated" is exactly the sort
 * of question that drifts between two pages. This is UX only: the API decides
 * ownership, and a build that skips this gate simply gets a 401 instead of a
 * prompt.
 */
export function mustSignIn({ configured, signedIn } = {}) {
  return Boolean(configured) && !signedIn;
}
