'use client';

import { useEffect, useState } from 'react';
import { fetchAuthSession, getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { authConfigured, configureAmplify } from '@/lib/amplify';

type State = { phase: 'loading' } | { phase: 'signed-out' } | { phase: 'signed-in'; email: string };

/** Wraps the app: nothing renders until the single owner account is signed in. */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    configureAmplify();
    if (!authConfigured) return;
    (async () => {
      try {
        await getCurrentUser();
        const session = await fetchAuthSession();
        const email = (session.tokens?.idToken?.payload.email as string | undefined) ?? 'signed in';
        setState({ phase: 'signed-in', email });
      } catch {
        setState({ phase: 'signed-out' });
      }
    })();
  }, []);

  if (!authConfigured) {
    return (
      <main className="centered">
        <div className="card notice">
          <h1>Not configured yet</h1>
          <p>
            The web app has no user pool to talk to. Deploy the stack and write the env file:
          </p>
          <pre>cd infra &amp;&amp; npm run deploy{'\n'}./scripts/write-web-env.sh</pre>
        </div>
      </main>
    );
  }

  if (state.phase === 'loading') {
    return (
      <main className="centered">
        <p className="muted">Checking your session…</p>
      </main>
    );
  }

  if (state.phase === 'signed-out') {
    return (
      <main className="centered">
        <div className="card notice">
          <h1>Reel Lens</h1>
          <p className="muted">Sign in with the owner account to reach your library.</p>
          <button className="primary" onClick={() => signInWithRedirect()}>
            Sign in
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <strong>Reel Lens</strong>
        <span className="muted small">{state.email}</span>
        <button className="ghost small" onClick={() => signOut()}>
          Sign out
        </button>
      </header>
      {children}
    </>
  );
}
