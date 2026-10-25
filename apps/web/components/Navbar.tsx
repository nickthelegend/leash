import React from 'react';
import { LeashLogo } from './Logo';

const REPO_URL = 'https://github.com/nickthelegend/leash';

/** Landing nav on the yellow hero: logo left, sections and the console on the right. The evidence page
 *  lists its own sections and links back to the console on the landing. */
export function Navbar({ page = 'landing' }: { page?: 'landing' | 'evidence' }) {
  const links: Array<[string, string]> =
    page === 'evidence'
      ? [
          ['Tag', '#tag'],
          ['Lead', '#lead'],
          ['Snaps', '#snaps'],
          ['Walk log', '#walk'],
        ]
      : [
          ['How it works', '#how'],
          ['Proof', '#proof'],
          ['Evidence', '/evidence'],
        ];
  return (
    <nav className="lz-nav" aria-label="Main">
      <div className="lz-wrap lz-nav-row">
        <LeashLogo tone="deep" href={page === 'evidence' ? '/' : undefined} />
        <div className="lz-nav-right">
          <ul>
            {links.map(([label, href]) => (
              <li key={href}>
                <a href={href}>{label}</a>
              </li>
            ))}
            <li>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                GitHub
              </a>
            </li>
          </ul>
          <a className="btn btn-dark btn-sm" href={page === 'evidence' ? '/#console' : '#console'}>
            Console
          </a>
        </div>
      </div>
    </nav>
  );
}

export { REPO_URL };
