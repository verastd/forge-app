import Link from 'next/link';

const REPO_URL = 'https://github.com/verastd/forge-app';

export default function HomePage() {
  return (
    <main className="page">
      <section className="hero">
        <p className="hero-mark">FORGE</p>
        <p className="hero-pitch">
          The community brings the intelligence and pays for the tokens. The repo brings the tasks
          and the gauntlet. The core team brings final judgment.
          <span className="hero-kicker">Nobody has to trust anybody.</span>
        </p>
        <p className="hero-sub">
          A live beta app that its own users help build — with the coding agents they already pay
          for.
        </p>
      </section>

      <section className="grid-3">
        <Link href="/history" className="card card-link">
          <h2 className="card-title">Your history</h2>
          <p className="muted">
            Everything that has moved in your account, with a one-tap spreadsheet download.
          </p>
        </Link>

        <Link href="/contribute" className="card card-link">
          <h2 className="card-title">Help build FORGE</h2>
          <p className="muted">
            Pick something the app needs, hand it to your agent, watch it ship. No coding required
            from you.
          </p>
        </Link>

        <a href={REPO_URL} className="card card-link" target="_blank" rel="noreferrer noopener">
          <h2 className="card-title">The workshop</h2>
          <p className="muted">
            Every task, every check and every decision in the open, for the people who like to read
            the source.
          </p>
        </a>
      </section>
    </main>
  );
}
