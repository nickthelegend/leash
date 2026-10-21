import React from 'react';
import { LeashLogo } from './Logo';

const REPO_URL = 'https://github.com/nickthelegend/leash';

/** Landing nav on the yellow hero: logo left, sections and the console on the right. */
export function Navbar() {
  return (
    <nav className="lz-nav" aria-label="Main">
      <div className="lz-wrap lz-nav-row">
        <LeashLogo tone="deep" />
        <div className="lz-nav-right">
          <ul>
            <li>
              <a href="#tag">Tag</a>
            </li>
            <li>
              <a href="#lead">Lead</a>
            </li>
            <li>
              <a href="#snaps">Snaps</a>
            </li>
            <li>
              <a href="#walk">Walk log</a>
            </li>
            <li>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                GitHub
              </a>
            </li>
          </ul>
          <a className="btn btn-dark btn-sm" href="#console">
            Console
          </a>
        </div>
      </div>
    </nav>
  );
}

export { REPO_URL };
