/**
 * Every unmatched URL lands here. It carries its own ways out because the
 * chrome around it varies: SiteChrome renders no site nav under
 * /apps/<slug> ("app" mode), so a 404 there would otherwise be a dead end.
 */

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Page not found</h1>
        <p className="lede">There is nothing at this address, or it has moved.</p>
      </div>
      <div className="row">
        <Link href="/apps" className="btn btn-primary">
          Go to the lobby
        </Link>
        <Link href="/" className="btn">
          Go home
        </Link>
      </div>
    </main>
  );
}
