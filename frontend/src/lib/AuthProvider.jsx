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
  //
  // DURING RENDER, not from an effect. React runs passive effects
  // children-before-parents, so a page that fetches on mount ran its effect
  // before this provider's -- and sent its first request with no
  // Authorization header. That was harmless while reads were public. Once
  // GET /drafts/{id} and the /me routes were gated it meant every cold load
  // and every refresh began with a 401 the Lambda never saw: both dashboard
  // error banners, or a draft that would not open until you navigated to it
  // from inside the app.
  //
  // StrictMode's double-invoked effects hid it in development by firing a
  // second, authenticated request, and route mocks in the e2e suite fulfil
  // regardless of headers -- so nothing caught it.
  //
  // The call is idempotent, so a render React later discards costs nothing.
  setCurrentIdToken(idTokenOf(user));

  // Clearing still belongs in an effect: it must happen on unmount, not on
  // every render.
  useEffect(() => () => setCurrentIdToken(null), []);

  const value = useMemo(
    () => ({
      user,
      name: displayNameOf(user),
      signedIn: isActive(user),
      // The Cognito subject: the id the API writes as ownerId and as the sub
      // on your seat in a draft.
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

