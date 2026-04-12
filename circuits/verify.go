package circuits

import (
	"fmt"
	"math/big"

	"github.com/consensys/gnark/backend/plonk"
	plonk_bn254 "github.com/consensys/gnark/backend/plonk/bn254"
	"github.com/consensys/gnark-crypto/ecc"
)

// VerifyResult contains the verification result
type VerifyResult struct {
	Valid        bool
	PublicInputs []uint64
	Error        error
}

// Verify verifies a Plonk proof
func Verify(vk *plonk_bn254.VerifyingKey, proof *plonk_bn254.Proof, threshold uint64) (bool, error) {
	// Create public witness
	publicWitness, err := frontend.NewWitness(
		map[string]interface{}{"threshold": threshold},
		ecc.BN254,
	)
	if err != nil {
		return false, fmt.Errorf("failed to create witness: %w", err)
	}

	// Verify the proof
	err = plonk.Verify(vk, publicWitness, proof)
	if err != nil {
		return false, nil
	}

	return true, nil
}

// VerifyThreshold checks if secret > threshold without revealing secret
func VerifyThreshold(proof *plonk_bn254.Proof, vk *plonk_bn254.VerifyingKey, threshold uint64) (bool, error) {
	return Verify(vk, proof, threshold)
}

// BatchVerify verifies multiple proofs in batch
func BatchVerify(vk *plonk_bn254.VerifyingKey, proofs []*plonk_bn254.Proof, thresholds []uint64) ([]bool, error) {
	if len(proofs) != len(thresholds) {
		return nil, fmt.Errorf("proof and threshold count mismatch")
	}

	results := make([]bool, len(proofs))

	for i, proof := range proofs {
		valid, err := Verify(vk, proof, thresholds[i])
		if err != nil {
			results[i] = false
			continue
		}
		results[i] = valid
	}

	return results, nil
}

// ExportVerifierABI exports verifier as ABI-compatible format
func ExportVerifierABI(vk *plonk_bn254.VerifyingKey) (map[string]interface{}, error) {
	// Export verification key in format suitable for AVM
	return map[string]interface{}{
		"curve":            "BN254",
		"backend":          "PLONK",
		"num_public_inputs": 1,
		"num_constraints":  vk.CircuitInfo.NumConstraints,
		"num_wire":         vk.CircuitInfo.NumWires,
	}, nil
}

// GetVerifierConstants returns precomputed constants for AVM integration
func GetAVMVerifierConstants() map[string]interface{} {
	return map[string]interface{}{
		// BN254 curve constants (hex format for AVM)
		"curve_order": [4]uint64{
			0x3C208C72D643F2D5,
			0x6871CA8D44988F06,
			0xF3D0C44200000001,
			0x4D1037BF,
		},
		"field_modulus": [4]uint64{
			0x3C208C72D643F2D5,
			0x6871CA8D44988E06,
			0xF3D0C44200000001,
			0x4D1037BF,
		},
		// G1 generator
		"g1_gen": [2]uint64{
			0x0000000000000001,
			0x0000000000000002,
		},
		// G2 generator (decomposed into two field elements)
		"g2_gen_x0": [2]uint64{
			0x8D999260C9F278D1,
			0x2215F3F9C1B78A26,
		},
		"g2_gen_x1": [2]uint64{
			0x1C1DC400D384C8A0,
			0x0F664C71F2E015B6,
		},
		"g2_gen_y0": [2]uint64{
			0xB634C57F45A4C3CE,
			0x5B0C2C49F15E7C6E,
		},
		"g2_gen_y1": [2]uint64{
			0x4FE0C110BFFF5D5D,
			0x4F53D1DE64CEC7D0,
		},
	}
}

// SplitVerification represents multi-transaction verification
type SplitVerification struct {
	Stage          int
	CommitmentHash [32]byte
	ProofValid     bool
	PairingVerified bool
}

// SplitVerifyStage1 performs first verification stage
func SplitVerifyStage1(proof *plonk_bn254.Proof) (*SplitVerification, error) {
	result := &SplitVerification{
		Stage:          1,
		CommitmentHash: ComputeProofHash(proof),
	}
	return result, nil
}

// SplitVerifyStage2 validates proof structure
func SplitVerifyStage2(proof *plonk_bn254.Proof, stage1 *SplitVerification) error {
	if len(proof.OpeningProof.H) == 0 {
		return fmt.Errorf("invalid proof structure")
	}
	stage1.ProofValid = true
	return nil
}

// SplitVerifyStage3 performs final verification
func SplitVerifyStage3(
	vk *plonk_bn254.VerifyingKey,
	proof *plonk_bn254.Proof,
	threshold uint64,
	stage2 *SplitVerification,
) (bool, error) {
	if !stage2.ProofValid {
		return false, fmt.Errorf("proof structure invalid")
	}
	return Verify(vk, proof, threshold)
}

// EstimateAVMOpcodeCost estimates opcode budget for verification
func EstimateAVMOpcodeCost() map[string]interface{} {
	return map[string]interface{}{
		"stage1_precheck":    500,
		"stage2_hash":       2000,
		"stage3_verify":      15000,
		"total_estimated":    17500,
		"fits_in_single_txn": true,
		"opcode_budget":      70000,
		"remaining_budget":   52500,
	}
}
