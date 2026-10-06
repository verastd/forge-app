import { redirect } from 'next/navigation';

/**
 * The avatar editor's first address. It moved to /me/avatars, under the site
 * nav: every /apps/<slug> route is a full-screen app with no site chrome.
 */
export default function AvatarsMoved(): never {
  redirect('/me/avatars');
}
