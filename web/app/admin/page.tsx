'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  adminUsage,
  isAdmin,
  listInvites,
  revokeInvite,
  sendInvite,
  type AccountUsage,
  type Invite,
} from '@/lib/api';

/** FORCE_CHANGE_PASSWORD is Cognito's way of saying "invited, never signed in". */
const STATUS_LABEL: Record<string, string> = {
  FORCE_CHANGE_PASSWORD: 'Invited',
  CONFIRMED: 'Joined',
  RESET_REQUIRED: 'Password reset needed',
  REVOKED: 'Revoked',
  UNKNOWN: 'Unknown',
};

const mb = (bytes = 0) => `${(bytes / 1_000_000).toFixed(bytes > 100_000_000 ? 0 : 1)} MB`;
const thousands = (n = 0) => n.toLocaleString();

/**
 * Admin: invite people, and see what each account has cost.
 *
 * Signup is closed, so this screen is how anyone else gets in. The allowed
 * check here only decides whether to render — every route behind it re-checks
 * the same group claim server-side.
 */
export default function AdminPage() {
  const [allowed, setAllowed] = useState<boolean | undefined>();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [accounts, setAccounts] = useState<AccountUsage[]>([]);
  const [period, setPeriod] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();

  async function refresh() {
    const [i, u] = await Promise.all([listInvites(), adminUsage()]);
    setInvites(i.invites);
    setAccounts(u.accounts);
    setPeriod(u.period.replace('usage#', ''));
  }

  useEffect(() => {
    void (async () => {
      const ok = await isAdmin();
      setAllowed(ok);
      if (ok) {
        try {
          await refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'could not load');
        }
      }
    })();
  }, []);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    setError(undefined);
    setSent(undefined);
    try {
      await sendInvite(address);
      setEmail('');
      setSent(address);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the invite failed');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(address: string) {
    setError(undefined);
    try {
      await revokeInvite(address);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not withdraw the invite');
    }
  }

  if (allowed === undefined) {
    return (
      <main className="page">
        <p className="muted small">Checking…</p>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="page">
        <Link href="/" className="btn">
          ← Library
        </Link>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted">This page is for administrators.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <Link href="/" className="btn">
        ← Library
      </Link>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Invite someone</h2>
        <p className="muted small">
          Signup is closed, so this is the only way in. Cognito emails them a temporary
          password; they set their own on first sign-in.
        </p>
        <form className="url-form" onSubmit={invite}>
          <input
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <button className="btn primary" type="submit" disabled={busy || !email.trim()}>
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </form>
        {sent && <p className="muted small">Invited {sent}.</p>}
        {error && <p className="error small">{error}</p>}
      </div>

      <h2>People</h2>
      <div className="card">
        {invites.length === 0 ? (
          <p className="muted small">Nobody has been invited yet.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Invited</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map((row) => (
                <tr key={row.email}>
                  <td>{row.email}</td>
                  <td>
                    <span className={`chip ${row.status === 'CONFIRMED' ? 'chip-ready' : ''}`}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </span>
                  </td>
                  <td className="when">{row.created_at.slice(0, 10)}</td>
                  <td>
                    {/* Only an unaccepted invite. Removing a member who has a
                        library is a different, destructive operation and should
                        not live behind a button on this row. */}
                    {row.status === 'FORCE_CHANGE_PASSWORD' && (
                      <button className="btn small" onClick={() => withdraw(row.email)}>
                        Withdraw
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Usage {period && `· ${period}`}</h2>
      <div className="card">
        {accounts.length === 0 ? (
          <p className="muted small">Nothing recorded this month.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Saves</th>
                <th className="num">Downloads</th>
                <th className="num">Data</th>
                <th className="num">Analyses</th>
                <th className="num">Plans</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.user_id}>
                  {/* The Cognito sub. Shortened because it identifies an account
                      without being anything a reader needs in full. */}
                  <td className="mono">{a.user_id.slice(0, 8)}</td>
                  <td className="num">{thousands(a.saves)}</td>
                  <td className="num">{thousands(a.downloads)}</td>
                  <td className="num">{mb(a.bytes_downloaded)}</td>
                  <td className="num">{thousands(a.analyses)}</td>
                  <td className="num">{thousands(a.plans)}</td>
                  <td className="num">
                    {thousands((a.tokens_in ?? 0) + (a.tokens_out ?? 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Charged to whoever caused the work: the account that pasted a link wears its
          download and analysis, and everyone who saves it afterwards spends nothing.
        </p>
      </div>
    </main>
  );
}
