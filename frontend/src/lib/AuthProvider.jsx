import { useEffect, useMemo, useState } from "react";
import { getUserManager, isAuthConfigured, idTokenOf, displayNameOf, isActive } from "./auth";
import { setCurrentIdToken } from "./idToken.js";
import { AuthContext } from "./authContext.js";

export function AuthProvider({ children }) {
  const manager = getUserManager();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(isAuthConfigured);

  useEffect(() => {
    if (!manager) return;
    let cancelled = false;

    manager
      .getUser()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      // A broken or expired stored session must leave the app usable signed
      // out, never stuck on a spinner.
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const onLoaded = (u) => setUser(u);
    const onUnloaded = () => setUser(null);
    manager.events.addUserLoaded(onLoaded);
    manager.events.addUserUnloaded(onUnloaded);

    return () => {
      cancelled = true;
      manager.events.removeUserLoaded(onLoaded);
      manager.events.removeUserUnloaded(onUnloaded);
    };
  }, [manager]);

  // Published to the plain holder api.js reads, so requests can carry a token
  // without any of the request code importing React.
  useEffect(() => {
    setCurrentIdToken(idTokenOf(user));
    return () => setCurrentIdToken(null);
  }, [user]);

  const value = useMemo(
    () => ({
      user,
      name: displayNameOf(user),
      signedIn: isActive(user),
      // The Cognito subject: the id the API writes as ownerId, and the key the
      // claim marker is stored under.
      sub: isActive(user) ? user.profile?.sub ?? null : null,
      loading,
      configured: isAuthConfigured,
      signIn: () =>
        manager?.signinRedirect({
          // Come back to where they were, not to the home page.
          state: { returnTo: window.location.pathname + window.location.search },
        }),
      signOut: () => manager?.signoutRedirect(),
    }),
    [user, loading, manager]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

