use std::hash::pedersen_hash;

struct PolicyBundle {
    merkle_root: Field,
    policy_commitment: Field,
    layer1: [Field; 8],
    layer2: [Field; 4],
    layer3: [Field; 2],
    merchant_hashes: [Field; 16],
}

fn main(leaves: [Field; 16], max_per_tx: Field, policy_salt: Field) -> pub PolicyBundle {
    let mut merchant_hashes: [Field; 16] = [0; 16];
    for i in 0..16 {
        merchant_hashes[i] = pedersen_hash([leaves[i], 0]);
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
    let policy_commitment = pedersen_hash([merkle_root, max_per_tx, policy_salt]);

    PolicyBundle {
        merkle_root,
        policy_commitment,
        layer1,
        layer2,
        layer3,
        merchant_hashes,
    }
}
