// Live Mezo protocol facts, read from Mezo testnet's own contracts (mezo-org/musd matsnet deployment) at one block.
// Satoshi answers with them and the arbiter judges with them, so answers about Mezo are checked against the chain.
import { parseAbi, formatUnits } from 'viem';
import { pub, MEZO } from './chain.mjs';

const TROVE_MANAGER = '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0';
const BORROWER_OPS = '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5';
const PRICE_FEED = '0x86bCF0841622a5dAC14A313a15f96A95421b9366';
const SORTED_TROVES = '0x722E4D24FD6Ff8b0AC679450F3D91294607268fA';
const abi = parseAbi([
  'function fetchPrice() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function MCR() view returns (uint256)',
  'function CCR() view returns (uint256)',
  'function borrowingRate() view returns (uint256)',
  'function minNetDebt() view returns (uint256)',
  'function getSize() view returns (uint256)',
  'function getEntireSystemColl() view returns (uint256)',
  'function getEntireSystemDebt() view returns (uint256)',
]);

let cache = { at: 0, value: null };

export async function mezoFacts() {
  if (cache.value && Date.now() - cache.at < 30_000) return cache.value;
  const blockNumber = await pub.getBlockNumber();
  const r = (address, functionName) => pub.readContract({ address, abi, functionName, blockNumber });
  const [price, supply, mcr, ccr, rate, minDebt, troves, coll, debt] = await Promise.all([
    r(PRICE_FEED, 'fetchPrice'), r(MEZO.musd, 'totalSupply'), r(TROVE_MANAGER, 'MCR'), r(TROVE_MANAGER, 'CCR'),
    r(BORROWER_OPS, 'borrowingRate'), r(BORROWER_OPS, 'minNetDebt'), r(SORTED_TROVES, 'getSize'),
    r(TROVE_MANAGER, 'getEntireSystemColl'), r(TROVE_MANAGER, 'getEntireSystemDebt'),
  ]);
  const n = (v, d = 18) => Number(formatUnits(v, d));
  const btcUsd = n(price);
  const tcr = (n(coll) * btcUsd) / n(debt);
  const value = {
    block: Number(blockNumber),
    btcUsd: Math.round(btcUsd * 100) / 100,
    musdSupply: Math.round(n(supply)),
    mcrPct: Math.round(n(mcr) * 10000) / 100,
    ccrPct: Math.round(n(ccr) * 10000) / 100,
    borrowingFeePct: Math.round(n(rate) * 100000) / 1000,
    minNetDebtMusd: n(minDebt),
    troves: Number(troves),
    systemCollBtc: Math.round(n(coll) * 1000) / 1000,
    systemDebtMusd: Math.round(n(debt)),
    tcrPct: Math.round(tcr * 1000) / 10,
  };
  value.text =
    `Live Mezo testnet data at block ${value.block} (read from Mezo's own contracts just now): ` +
    `BTC price from Mezo's PriceFeed $${value.btcUsd.toLocaleString('en-US')}; MUSD total supply ${value.musdSupply.toLocaleString('en-US')}; ` +
    `${value.troves} open Mezo Borrow troves holding ${value.systemCollBtc.toLocaleString('en-US')} BTC against ${value.systemDebtMusd.toLocaleString('en-US')} MUSD of debt ` +
    `(system collateral ratio ${value.tcrPct}%); minimum collateral ratio (MCR) ${value.mcrPct}%; critical collateral ratio (CCR) ${value.ccrPct}%; ` +
    `borrowing fee ${value.borrowingFeePct}%; minimum net debt per trove ${value.minNetDebtMusd.toLocaleString('en-US')} MUSD.`;
  cache = { at: Date.now(), value };
  return value;
}
