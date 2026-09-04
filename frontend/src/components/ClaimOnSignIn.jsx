import { useClaimOnSignIn } from "../lib/useClaimOnSignIn.js";

/**
 * A mount point for the claim effect, rendered inside <AuthProvider> so it can
 * read the context App itself provides. Renders nothing.
 */
export default function ClaimOnSignIn() {
  useClaimOnSignIn();
  return null;
}
