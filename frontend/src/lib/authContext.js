import { createContext, useContext } from "react";

/**
 * The context and its hook, apart from the provider component.
 *
 * Fast refresh only works for a module that exports components alone, so a
 * hook living beside <AuthProvider> would break hot reload for every consumer
 * of it. Splitting them costs one file and keeps the dev loop intact.
 */
export const AuthContext = createContext({
  user: null,
  name: null,
  loading: false,
  configured: false,
  signIn: () => {},
  signOut: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}
