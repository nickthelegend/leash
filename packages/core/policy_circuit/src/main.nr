use std::hash::pedersen_hash;

// Computes the allowlist tree and policy commitment with exactly the hashing of circuits/src/main.nr,
// so the TypeScript side never re-implements Pedersen.

struct PolicyBundle {
    merkle_root: Field,
    policy_commitment: Field,
    leaves: [Field; 16],
    layer1: [Field; 8],
    layer2: [Field; 4],
    layer3: [Field; 2],
    merchant_hashes: [Field; 16],
}

fn main(
    merchant_ids: [Field; 16],
    payees: [Field; 16],
    max_per_tx: Field,
    daily_cap: Field,
    policy_salt: Field,
    spend_salt: Field,
) -> pub PolicyBundle {
    let mut leaves: [Field; 16] = [0; 16];
    let mut merchant_hashes: [Field; 16] = [0; 16];
    for i in 0..16 {
        // Empty slots stay 0: no (merchant, payee, salt) hashes to 0, so they can't be proven.
        if merchant_ids[i] != 0 {
            leaves[i] = pedersen_hash([merchant_ids[i], payees[i], policy_salt]);
            merchant_hashes[i] = pedersen_hash([merchant_ids[i], policy_salt]);
        }
    }

    let mut layer1: [Field; 8] = [0; 8];
    for i in 0..8 {
        layer1[i] = pedersen_hash([leaves[2 * i], leaves[2 * i + 1]]);
    }
    let mut layer2: [Field; 4] = [0; 4];
    for i in 0..4 {
        layer2[i] = pedersen_hash([layer1[2 * i], layer1[2 * i + 1]]);
    }
    let mut layer3: [Field; 2] = [0; 2];
    for i in 0..2 {
        layer3[i] = pedersen_hash([layer2[2 * i], layer2[2 * i + 1]]);
    }
    let merkle_root = pedersen_hash([layer3[0], layer3[1]]);
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, daily_cap, policy_salt, spend_salt]);

    PolicyBundle { merkle_root, policy_commitment, leaves, layer1, layer2, layer3, merchant_hashes }
}
