use std::hash::pedersen_hash;

global MERKLE_DEPTH: u32 = 4;

// Allowlist leaf: a merchant bound to its payee, salted with the policy salt so leaves (and the
// tree) can't be rebuilt from a dictionary of merchant names and payees.
// payee is an EVM address, or the low 160 bits of keccak256("leash:paypal:" + merchant_id) for a
// PayPal merchant (see packages/core/src/crypto/evm.ts paypalPayee).
pub fn merchant_leaf(merchant_id: Field, payee: Field, policy_salt: Field) -> Field {
    pedersen_hash([merchant_id, payee, policy_salt])
}

// Public merchant hash, salted so it can't be dictionary-reversed from events or receipts.
pub fn merchant_hash(merchant_id: Field, policy_salt: Field) -> Field {
    pedersen_hash([merchant_id, policy_salt])
}

pub fn policy_hash(
    merkle_root: Field,
    max_per_tx: Field,
    daily_cap: Field,
    policy_salt: Field,
    spend_salt: Field,
) -> Field {
    pedersen_hash([merkle_root, max_per_tx, daily_cap, policy_salt, spend_salt])
}

// Hiding commitment to the amount already spent in `epoch` (UTC day).
pub fn spend_commit(spent: Field, epoch: Field, spend_salt: Field) -> Field {
    pedersen_hash([spent, epoch, spend_salt])
}

pub fn compute_merkle_root(
    leaf: Field,
    path_indices: [bool; MERKLE_DEPTH],
    path_elements: [Field; MERKLE_DEPTH],
) -> Field {
    let mut current = leaf;
    for i in 0..MERKLE_DEPTH {
        let sibling = path_elements[i];
        if path_indices[i] {
            current = pedersen_hash([sibling, current]);
        } else {
            current = pedersen_hash([current, sibling]);
        }
    }
    current
}

// Public inputs, in order: policy_commitment, amount, merchant_id_hash, nonce, recipient, epoch,
// prev_spend_commit, then the return value new_spend_commit. LeashPayment.sol builds the same array.
fn main(
    policy_commitment: pub Field,
    amount: pub Field,
    merchant_id_hash: pub Field,
    nonce: pub Field,
    recipient: pub Field,
    epoch: pub Field,
    prev_spend_commit: pub Field,
    // Private: the policy (bound by policy_commitment) and the running daily total.
    max_per_tx: Field,
    daily_cap: Field,
    merkle_root: Field,
    policy_salt: Field,
    spend_salt: Field,
    merchant_id: Field,
    spent_before: Field,
    merkle_path_indices: [bool; MERKLE_DEPTH],
    merkle_path_elements: [Field; MERKLE_DEPTH],
) -> pub Field {
    // 1. The private policy (allowlist root, per-tx cap, daily cap, salts) opens the public commitment.
    assert(
        policy_commitment == policy_hash(merkle_root, max_per_tx, daily_cap, policy_salt, spend_salt),
        "Policy commitment mismatch",
    );

    // 2. Per-transaction cap. Range-check before casting: `as u64` alone truncates, so 2^64 + 100
    // would pass a 500 cap while the contract releases the full uint256 amount.
    amount.assert_max_bit_size::<64>();
    max_per_tx.assert_max_bit_size::<64>();
    assert((amount as u64) <= (max_per_tx as u64), "Amount exceeds per-transaction cap");

    // 3. Salted merchant hash binding.
    assert(merchant_id_hash == merchant_hash(merchant_id, policy_salt), "Merchant ID hash mismatch");

    // 4. Allowlist membership of the (merchant, payee) pair. The payee is the public recipient, so a
    // proof for an allowlisted merchant can't name any payee other than the one the owner listed.
    recipient.assert_max_bit_size::<160>();
    let leaf = merchant_leaf(merchant_id, recipient, policy_salt);
    assert(
        compute_merkle_root(leaf, merkle_path_indices, merkle_path_elements) == merkle_root,
        "Merchant/payee pair not in allowlist",
    );

    // 5. Rolling daily cap. prev_spend_commit opens to spent_before for this epoch, or is 0 for the
    // first payment of a new epoch (then spent_before must be 0). LeashPayment stores the latest
    // commitment per policy and only accepts a proof whose prev matches it, so two proofs built on
    // the same prev can't both land.
    epoch.assert_max_bit_size::<64>();
    spent_before.assert_max_bit_size::<64>();
    daily_cap.assert_max_bit_size::<64>();
    let fresh = (prev_spend_commit == 0) & (spent_before == 0);
    assert(
        fresh | (prev_spend_commit == spend_commit(spent_before, epoch, spend_salt)),
        "Stale or forged spend commitment",
    );
    let spent_after = spent_before + amount; // both < 2^64, so no field wraparound
    spent_after.assert_max_bit_size::<64>();
    assert((spent_after as u64) <= (daily_cap as u64), "Amount exceeds daily cap");

    // 6. The nonce is a public input, so the proof only verifies for this nonce.
    let _ = nonce;

    spend_commit(spent_after, epoch, spend_salt)
}

// ---------------------------------------------------------------- tests

global TEST_RECIPIENT: Field = 0x1234567890123456789012345678901234567890;
global ATTACKER: Field = 0x000000000000000000000000000000000000dEaD;
global SALT: Field = 987654321;
global SPEND_SALT: Field = 55555;
global EPOCH: Field = 20747;

struct Policy {
    max_per_tx: Field,
    daily_cap: Field,
    merchant_id: Field,
    payee: Field,
    indices: [bool; MERKLE_DEPTH],
    elements: [Field; MERKLE_DEPTH],
}

fn policy(max_per_tx: Field, daily_cap: Field) -> Policy {
    Policy {
        max_per_tx,
        daily_cap,
        merchant_id: 42,
        payee: TEST_RECIPIENT,
        indices: [false, true, false, false],
        elements: [101, 202, 303, 404],
    }
}

fn root_of(p: Policy) -> Field {
    compute_merkle_root(merchant_leaf(p.merchant_id, p.payee, SALT), p.indices, p.elements)
}

fn commitment_of(p: Policy) -> Field {
    policy_hash(root_of(p), p.max_per_tx, p.daily_cap, SALT, SPEND_SALT)
}

// Pays `amount` to `recipient` under policy p with the given spend state; returns the new commit.
fn pay(p: Policy, amount: Field, recipient: Field, epoch: Field, prev: Field, spent_before: Field) -> Field {
    main(
        commitment_of(p),
        amount,
        merchant_hash(p.merchant_id, SALT),
        1,
        recipient,
        epoch,
        prev,
        p.max_per_tx,
        p.daily_cap,
        root_of(p),
        SALT,
        SPEND_SALT,
        p.merchant_id,
        spent_before,
        p.indices,
        p.elements,
    )
}

#[test]
fn test_valid_payment() {
    let next = pay(policy(500, 1000), 300, TEST_RECIPIENT, EPOCH, 0, 0);
    assert(next == spend_commit(300, EPOCH, SPEND_SALT));
}

#[test]
fn test_exact_cap_payment() {
    let _ = pay(policy(500, 500), 500, TEST_RECIPIENT, EPOCH, 0, 0);
}

#[test(should_fail_with = "Amount exceeds per-transaction cap")]
fn test_over_cap_fails() {
    let _ = pay(policy(500, 100000), 50000, TEST_RECIPIENT, EPOCH, 0, 0);
}

#[test(should_fail_with = "Merchant/payee pair not in allowlist")]
fn test_unauthorized_merchant_fails() {
    let p = policy(500, 1000);
    let attacker_merchant: Field = 99999;
    let _ = main(
        commitment_of(p),
        300,
        merchant_hash(attacker_merchant, SALT),
        1,
        TEST_RECIPIENT,
        EPOCH,
        0,
        p.max_per_tx,
        p.daily_cap,
        root_of(p),
        SALT,
        SPEND_SALT,
        attacker_merchant,
        0,
        p.indices,
        p.elements,
    );
}

// The injection the payee binding stops: an allowlisted merchant (42) with the payee swapped for
// the attacker's address. Before, recipient was free; now it must be the payee in the leaf.
#[test(should_fail_with = "Merchant/payee pair not in allowlist")]
fn test_allowlisted_merchant_attacker_payee_fails() {
    let _ = pay(policy(500, 1000), 300, ATTACKER, EPOCH, 0, 0);
}

#[test(should_fail_with = "Policy commitment mismatch")]
fn test_invalid_commitment_fails() {
    let p = policy(500, 1000);
    let _ = main(
        1122334455,
        300,
        merchant_hash(p.merchant_id, SALT),
        1,
        TEST_RECIPIENT,
        EPOCH,
        0,
        p.max_per_tx,
        p.daily_cap,
        root_of(p),
        SALT,
        SPEND_SALT,
        p.merchant_id,
        0,
        p.indices,
        p.elements,
    );
}

// Lying about the daily cap (or any policy field) breaks the commitment.
#[test(should_fail_with = "Policy commitment mismatch")]
fn test_inflated_daily_cap_breaks_commitment() {
    let p = policy(500, 500);
    let _ = main(
        commitment_of(p),
        300,
        merchant_hash(p.merchant_id, SALT),
        1,
        TEST_RECIPIENT,
        EPOCH,
        0,
        p.max_per_tx,
        100000,
        root_of(p),
        SALT,
        SPEND_SALT,
        p.merchant_id,
        0,
        p.indices,
        p.elements,
    );
}

#[test(should_fail_with = "Merchant ID hash mismatch")]
fn test_mismatched_merchant_hash_fails() {
    let p = policy(500, 1000);
    let _ = main(
        commitment_of(p),
        300,
        777777,
        1,
        TEST_RECIPIENT,
        EPOCH,
        0,
        p.max_per_tx,
        p.daily_cap,
        root_of(p),
        SALT,
        SPEND_SALT,
        p.merchant_id,
        0,
        p.indices,
        p.elements,
    );
}

// The unsalted hash of merchant 42 (what a dictionary attacker would compute) is not accepted.
#[test(should_fail_with = "Merchant ID hash mismatch")]
fn test_unsalted_merchant_hash_rejected() {
    let p = policy(500, 1000);
    let _ = main(
        commitment_of(p),
        300,
        pedersen_hash([p.merchant_id, 0]),
        1,
        TEST_RECIPIENT,
        EPOCH,
        0,
        p.max_per_tx,
        p.daily_cap,
        root_of(p),
        SALT,
        SPEND_SALT,
        p.merchant_id,
        0,
        p.indices,
        p.elements,
    );
}

// 2^64 + 100 truncates to 100 under `as u64`; the range check rejects it.
#[test(should_fail)]
fn test_amount_above_u64_wraparound_fails() {
    let _ = pay(policy(500, 1000), 18446744073709551716, TEST_RECIPIENT, EPOCH, 0, 0);
}

#[test(should_fail)]
fn test_recipient_above_160_bits_fails() {
    let _ = pay(policy(500, 1000), 300, 0x10000000000000000000000000000000000000000, EPOCH, 0, 0);
}

// Rolling daily cap: 200 + 200 fits a 500 cap, chained through the spend commitment.
#[test]
fn test_daily_two_payments_chain() {
    let p = policy(500, 500);
    let c1 = pay(p, 200, TEST_RECIPIENT, EPOCH, 0, 0);
    let c2 = pay(p, 200, TEST_RECIPIENT, EPOCH, c1, 200);
    assert(c2 == spend_commit(400, EPOCH, SPEND_SALT));
}

// 3 x 200 against a 500 daily cap: the third payment can't be proven.
#[test(should_fail_with = "Amount exceeds daily cap")]
fn test_daily_cap_third_200_fails() {
    let p = policy(500, 500);
    let c1 = pay(p, 200, TEST_RECIPIENT, EPOCH, 0, 0);
    let c2 = pay(p, 200, TEST_RECIPIENT, EPOCH, c1, 200);
    let _ = pay(p, 200, TEST_RECIPIENT, EPOCH, c2, 400);
}

// Under-reporting what was already spent doesn't open the stored commitment.
#[test(should_fail_with = "Stale or forged spend commitment")]
fn test_understated_spent_before_fails() {
    let p = policy(500, 500);
    let c1 = pay(p, 400, TEST_RECIPIENT, EPOCH, 0, 0);
    let _ = pay(p, 400, TEST_RECIPIENT, EPOCH, c1, 0);
}

// A commitment from yesterday doesn't open under today's epoch.
#[test(should_fail_with = "Stale or forged spend commitment")]
fn test_prev_from_other_epoch_fails() {
    let p = policy(500, 500);
    let c1 = pay(p, 400, TEST_RECIPIENT, EPOCH, 0, 0);
    let _ = pay(p, 100, TEST_RECIPIENT, EPOCH + 1, c1, 400);
}

// Epoch rollover: the next day starts from prev = 0, spent_before = 0.
#[test]
fn test_epoch_rollover_resets() {
    let p = policy(500, 500);
    let c1 = pay(p, 500, TEST_RECIPIENT, EPOCH, 0, 0);
    assert(c1 == spend_commit(500, EPOCH, SPEND_SALT));
    let d1 = pay(p, 500, TEST_RECIPIENT, EPOCH + 1, 0, 0);
    assert(d1 == spend_commit(500, EPOCH + 1, SPEND_SALT));
}
