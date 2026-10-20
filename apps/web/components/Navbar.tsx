'use client';

import React from 'react';
import { LeashLogo } from './Logo';

const REPO_URL = 'https://github.com/nickthelegend/leash';

/** Landing nav: links left, logo centre, actions right. Sits over the cobalt hero. */
export function Navbar() {
  return (
    <nav className="lp-nav" aria-label="Main">
      <div className="lp-wrap">
        <ul>
          <li>
            <a href="#how">How it works</a>
          </li>
          <li>
            <a href="#evidence">Recorded run</a>
          </li>
          <li>
            <a href="#faq">FAQ</a>
          </li>
        </ul>
        <LeashLogo className="text-white" />
        <div className="act">
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="btn btn-white btn-sm" href="#console">
            Open the console
          </a>
        </div>
      </div>
    </nav>
  );
}

export { REPO_URL };
