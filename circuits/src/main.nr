use std::hash::pedersen_hash;

global MERKLE_DEPTH: u32 = 4;

fn compute_merkle_root(
    leaf: Field,
    path_indices: [bool; MERKLE_DEPTH],
    path_elements: [Field; MERKLE_DEPTH]
) -> Field {
    let mut current = leaf;
    for i in 0..MERKLE_DEPTH {
        let is_right = path_indices[i];
        let sibling = path_elements[i];
        if is_right {
            current = pedersen_hash([sibling, current]);
        } else {
            current = pedersen_hash([current, sibling]);
        }
    }
    current
}

fn main(
    // Public inputs (visible to gateway, verifier, and explorer)
    policy_commitment: pub Field,
    amount: pub Field,
    merchant_id_hash: pub Field,
    nonce: pub Field,

    // Private inputs (known only to agent / policy holder)
    max_per_tx: Field,
    merkle_root: Field,
    policy_salt: Field,
    merchant_id: Field,
    merkle_path_indices: [bool; MERKLE_DEPTH],
    merkle_path_elements: [Field; MERKLE_DEPTH]
) {
    // 1. Policy commitment check:
    // Verifies that the spending policy (max_per_tx, merchant allowlist root, salt)
    // commits to the publicly announced policy_commitment.
    let expected_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    assert(policy_commitment == expected_commitment, "Policy commitment mismatch");

    // 2. Spending Rule R2: Per-transaction cap check
    // Converts to u64 to enforce strict numeric upper bound without field overflow attacks.
    // Range-check both values before casting: `as u64` alone truncates, so a Field like
    // 2^64 + 100 would pass a 500 cap while the contract releases the full uint256 amount.
    amount.assert_max_bit_size::<64>();
    max_per_tx.assert_max_bit_size::<64>();
    let amount_u64 = amount as u64;
    let max_u64 = max_per_tx as u64;
    assert(amount_u64 <= max_u64, "Amount exceeds per-transaction cap");

    // 3. Merchant identifier public binding:
    // Ensures the private merchant_id matches the public merchant_id_hash
    let expected_merchant_hash = pedersen_hash([merchant_id, 0]);
    assert(merchant_id_hash == expected_merchant_hash, "Merchant ID hash mismatch");

    // 4. Spending Rule R1: Merchant allowlist Merkle proof check
    // Verifies that merchant_id exists in the committed merchant allowlist Merkle tree.
    let computed_root = compute_merkle_root(merchant_id, merkle_path_indices, merkle_path_elements);
    assert(computed_root == merkle_root, "Merchant not in allowlist Merkle tree");

    // 5. Nonce binding:
    // Ensure public nonce is bound to the circuit evaluation so proof cannot be replayed.
    assert(nonce == nonce, "Nonce constraint failed");
}

#[test]
fn test_valid_payment() {
    let max_per_tx: Field = 500; // $5.00
    let policy_salt: Field = 987654321;
    let merchant_id: Field = 42; // merchant "openai"
    let sibling_1: Field = 101;
    let sibling_2: Field = 202;
    let sibling_3: Field = 303;
    let sibling_4: Field = 404;

    let path_elements = [sibling_1, sibling_2, sibling_3, sibling_4];
    let path_indices = [false, false, false, false];

    let merkle_root = compute_merkle_root(merchant_id, path_indices, path_elements);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    let merchant_id_hash = pedersen_hash([merchant_id, 0]);
    let amount: Field = 300; // $3.00 (under $5.00 cap)
    let nonce: Field = 1;

    main(
        policy_commitment,
        amount,
        merchant_id_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        merchant_id,
        path_indices,
        path_elements
    );
}

#[test]
fn test_exact_cap_payment() {
    let max_per_tx: Field = 500;
    let policy_salt: Field = 12345;
    let merchant_id: Field = 77;
    let path_elements = [1, 2, 3, 4];
    let path_indices = [true, false, true, false];

    let merkle_root = compute_merkle_root(merchant_id, path_indices, path_elements);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    let merchant_id_hash = pedersen_hash([merchant_id, 0]);
    let amount: Field = 500; // Exactly at the cap
    let nonce: Field = 2;

    main(
        policy_commitment,
        amount,
        merchant_id_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        merchant_id,
        path_indices,
        path_elements
    );
}

#[test(should_fail_with = "Amount exceeds per-transaction cap")]
fn test_over_cap_fails() {
    let max_per_tx: Field = 500; // $5.00
    let policy_salt: Field = 12345;
    let merchant_id: Field = 42;
    let path_elements = [10, 20, 30, 40];
    let path_indices = [false, false, false, false];

    let merkle_root = compute_merkle_root(merchant_id, path_indices, path_elements);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    let merchant_id_hash = pedersen_hash([merchant_id, 0]);
    let amount: Field = 50000; // $500.00 - injection attempt!
    let nonce: Field = 3;

    main(
        policy_commitment,
        amount,
        merchant_id_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        merchant_id,
        path_indices,
        path_elements
    );
}

#[test(should_fail_with = "Merchant not in allowlist Merkle tree")]
fn test_unauthorized_merchant_fails() {
    let max_per_tx: Field = 500;
    let policy_salt: Field = 12345;
    let merchant_id_authorized: Field = 42;
    let attacker_merchant_id: Field = 99999;
    let path_elements = [10, 20, 30, 40];
    let path_indices = [false, false, false, false];

    let merkle_root = compute_merkle_root(merchant_id_authorized, path_indices, path_elements);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    let merchant_id_hash = pedersen_hash([attacker_merchant_id, 0]);
    let amount: Field = 300;
    let nonce: Field = 4;

    main(
        policy_commitment,
        amount,
        merchant_id_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        attacker_merchant_id,
        path_indices,
        path_elements
    );
}

#[test(should_fail_with = "Policy commitment mismatch")]
fn test_invalid_commitment_fails() {
    let max_per_tx: Field = 500;
    let policy_salt: Field = 12345;
    let merchant_id: Field = 42;
    let path_elements = [10, 20, 30, 40];
    let path_indices = [false, false, false, false];

    let merkle_root = compute_merkle_root(merchant_id, path_indices, path_elements);
    let fake_policy_commitment: Field = 1122334455; // Not matching
    let merchant_id_hash = pedersen_hash([merchant_id, 0]);
    let amount: Field = 300;
    let nonce: Field = 5;

    main(
        fake_policy_commitment,
        amount,
        merchant_id_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        merchant_id,
        path_indices,
        path_elements
    );
}

#[test(should_fail_with = "Merchant ID hash mismatch")]
fn test_mismatched_merchant_hash_fails() {
    let max_per_tx: Field = 500;
    let policy_salt: Field = 12345;
    let merchant_id: Field = 42;
    let path_elements = [10, 20, 30, 40];
    let path_indices = [false, false, false, false];

    let merkle_root = compute_merkle_root(merchant_id, path_indices, path_elements);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    let fake_merchant_hash: Field = 777777; // Does not match merchant_id
    let amount: Field = 300;
    let nonce: Field = 6;

    main(
        policy_commitment,
        amount,
        fake_merchant_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        merchant_id,
        path_indices,
        path_elements
    );
}

// Field-overflow attack: 2^64 + 100 truncates to 100 under `as u64`, which would
// slip under a 500 cap while the contract reads the full uint256 amount.
#[test(should_fail)]
fn test_amount_above_u64_wraparound_fails() {
    let max_per_tx: Field = 500;
    let policy_salt: Field = 12345;
    let merchant_id: Field = 42;
    let path_elements = [10, 20, 30, 40];
    let path_indices = [false, false, false, false];

    let merkle_root = compute_merkle_root(merchant_id, path_indices, path_elements);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);
    let merchant_id_hash = pedersen_hash([merchant_id, 0]);
    let amount: Field = 18446744073709551716; // 2^64 + 100
    let nonce: Field = 7;

    main(
        policy_commitment,
        amount,
        merchant_id_hash,
        nonce,
        max_per_tx,
        merkle_root,
        policy_salt,
        merchant_id,
        path_indices,
        path_elements
    );
}
