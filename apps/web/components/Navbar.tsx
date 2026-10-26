import React from 'react';
import { LeashLogo } from './Logo';

const REPO_URL = 'https://github.com/nickthelegend/leash';

/** Landing nav on the yellow hero: logo left, sections and the console on the right. The evidence and
 *  Mezo pages list their own sections and link back to the console on the landing. */
export function Navbar({ page = 'landing' }: { page?: 'landing' | 'evidence' | 'mezo' }) {
  const links: Array<[string, string]> =
    page === 'evidence'
      ? [
          ['Tag', '#tag'],
          ['Lead', '#lead'],
          ['Snaps', '#snaps'],
          ['Walk log', '#walk'],
          ['Mezo', '/mezo'],
        ]
      : page === 'mezo'
        ? [
            ['Jobs', '#jobs'],
            ['How it works', '#how'],
            ['Contracts', '#contracts'],
          ]
        : [
            ['How it works', '#how'],
            ['Proof', '#proof'],
            ['Evidence', '/evidence'],
            ['Mezo', '/mezo'],
          ];
  const sub = page !== 'landing';
  return (
    <nav className="lz-nav" aria-label="Main">
      <div className="lz-wrap lz-nav-row">
        <LeashLogo tone="deep" href={sub ? '/' : undefined} />
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
          <a className="btn btn-dark btn-sm" href={sub ? '/#console' : '#console'}>
            Console
          </a>
        </div>
      </div>
    </nav>
  );
}

export { REPO_URL };
