/**
 * /me/avatars: the admin's avatar editor, under the site nav (an /apps/<slug>
 * route would be a full-screen app with none). Every member is a robot in the
 * Apps lobby (with `lobby_avatars` on); here an admin paints one, gives it a
 * chestplate image, picks its head, and keeps the head library (heads that
 * replace the robot's own, and face accessories worn over it).
 *
 * Signed in only (the middleware sends anyone else to /signin, as for all of
 * /me). Linked from the account menu for admins. Whether the
 * caller is an admin is the API's to say: the editor shows its refusal. The
 * practice account can't change anything, so it is told so here.
 */

import { getSession } from '../../../lib/session';
import { AvatarEditor } from './AvatarEditor';

export const metadata = { title: 'Robot avatars · FORGE' };

export default async function AvatarsPage() {
  const session = await getSession();
  return (
    <main className="page stack-lg">
      <div>
        <h1 className="page-title">Robot avatars</h1>
        <p className="lede">
          Everyone in the Apps lobby is a robot. Paint each one, give it a chestplate, and pick its head from the
          library.
        </p>
      </div>
      {session?.demo ? (
        <section className="card" role="status">
          <p className="card-title">The practice account can’t change avatars</p>
          <p className="muted">Sign in with GitHub as an admin to use the editor.</p>
        </section>
      ) : (
        <AvatarEditor />
      )}
    </main>
  );
}
