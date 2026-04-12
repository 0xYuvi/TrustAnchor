package circuits

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"math/big"
	"os"
	"path/filepath"

	"github.com/consensys/gnark"
	"github.com/consensys/gnark/backend/grothdown16"
	groth16_bn254 "github.com/consensys/gnark/backend/grothdown16/bn254"
	"github.com/consensys/gnark/backend/plonk"
	plonk_bn254 "github.com/consensys/gnark/backend/plonk/bn254"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark-crypto/ecc"
)

// ProvingKeyFile and VerifyingKeyFile paths
const (
	ProvingKeyFile   = "pk.plonk.key"
	VerifyingKeyFile = "vk.plonk.key"
	PlonkBackend     = backend.PLONK
	Curve            = ecc.BN254
)

// Setup generates the proving and verifying keys using Plonk
func Setup(circuit *GreaterThanCircuit, targetDir string) (*plonk_bn254.ProvingKey, *plonk_bn254.VerifyingKey, error) {
	// Compile the circuit
	ccs, err := frontend.Compile(
		Curve,
		PlonkBackend,
		circuit,
		frontend.WithCapacity(1<<18),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("circuit compilation failed: %w", err)
	}

	// Generate plonk proving key and verifying key
	pk, vk, err := plonk.Setup(ccs)
	if err != nil {
		return nil, nil, fmt.Errorf("setup failed: %w", err)
	}

	// Type assertion
	pkBN254 := pk.(*plonk_bn254.ProvingKey)
	vkBN254 := vk.(*plonk_bn254.VerifyingKey)

	// Save keys to files
	pkPath := filepath.Join(targetDir, ProvingKeyFile)
	vkPath := filepath.Join(targetDir, VerifyingKeyFile)

	pkFile, err := os.Create(pkPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create pk file: %w", err)
	}
	defer pkFile.Close()

	vkFile, err := os.Create(vkPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create vk file: %w", err)
	}
	defer vkFile.Close()

	_, err = pkBN254.WriteTo(pkFile)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to write pk: %w", err)
	}

	_, err = vkBN254.WriteTo(vkFile)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to write vk: %w", err)
	}

	return pkBN254, vkBN254, nil
}

// Prove generates a proof for the given witness using Plonk
func Prove(circuit *GreaterThanCircuit, pk *plonk_bn254.ProvingKey, secretValue, threshold uint64) (*plonk_bn254.Proof, error) {
	// Create witness
	witnessValues := make(map[string]interface{})
	witnessValues["threshold"] = threshold
	witnessValues["value"] = secretValue

	witness, err := frontend.NewWitness(witnessValues, Curve)
	if err != nil {
		return nil, fmt.Errorf("failed to create witness: %w", err)
	}

	// Generate proof
	proof, err := plonk.Prove(circuit, pk, witness)
	if err != nil {
		return nil, fmt.Errorf("proof generation failed: %w", err)
	}

	return proof.(*plonk_bn254.Proof), nil
}

// LoadKeys loads proving and verifying keys from files
func LoadKeys(targetDir string) (*plonk_bn254.ProvingKey, *plonk_bn254.VerifyingKey, error) {
	pkPath := filepath.Join(targetDir, ProvingKeyFile)
	vkPath := filepath.Join(targetDir, VerifyingKeyFile)

	pkFile, err := os.Open(pkPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open pk file: %w", err)
	}
	defer pkFile.Close()

	vkFile, err := os.Open(vkPath)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open vk file: %w", err)
	}
	defer vkFile.Close()

	var pk plonk_bn254.ProvingKey
	var vk plonk_bn254.VerifyingKey

	_, err = pk.ReadFrom(pkFile)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to read pk: %w", err)
	}

	_, err = vk.ReadFrom(vkFile)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to read vk: %w", err)
	}

	return &pk, &vk, nil
}

// ProveWithRandom generates proof with random inputs where secret > threshold
func ProveWithRandom(pk *plonk_bn254.ProvingKey, minValue, maxValue uint64) (*plonk_bn254.Proof, uint64, uint64, error) {
	// Generate random values ensuring secret > threshold
	secretValue, err := randomUint64(minValue, maxValue)
	if err != nil {
		return nil, 0, 0, err
	}

	// Threshold must be less than secret
	threshold := secretValue
	if threshold > minValue {
		threshold, err = randomUint64(minValue, threshold-1)
		if err != nil {
			return nil, 0, 0, err
		}
	} else {
		threshold = minValue - 1
	}

	// Create circuit instance
	circuit := NewGreaterThanCircuit()

	// Generate proof
	proof, err := Prove(circuit, pk, secretValue, threshold)
	if err != nil {
		return nil, 0, 0, err
	}

	return proof, secretValue, threshold, nil
}

// GenerateRandomWitness creates a random witness for testing
func GenerateRandomWitness(minValue, maxValue uint64) (secretValue, threshold uint64, err error) {
	return ProveWithRandom(nil, minValue, maxValue)
}

func randomUint64(min, max uint64) (uint64, error) {
	if max <= min {
		return min, nil
	}

	rangeSize := max - min + 1
	randomBytes := make([]byte, 8)
	_, err := rand.Read(randomBytes)
	if err != nil {
		return 0, err
	}

	randomValue := new(big.Int).SetBytes(randomBytes)
	randomValue.Mod(randomValue, new(big.Int).SetUint64(rangeSize))

	return min + randomValue.Uint64(), nil
}

// ExportSolidityVerifier generates Solidity verifier code
func ExportSolidityVerifier(vk *plonk_bn254.VerifyingKey, targetPath string) error {
	solidityCode, err := plonk.NewSolidityVerifier(vk)
	if err != nil {
		return fmt.Errorf("failed to generate Solidity verifier: %w", err)
	}

	return os.WriteFile(targetPath, []byte(solidityCode), 0644)
}

// GetVerifierConstants returns precomputed constants for AVM integration
func GetVerifierConstants() map[string]interface{} {
	return map[string]interface{}{
		// BN254 curve order
		"curve_order": "21888242871839275222246405745257275088548364400416034343698204186575808495617",
		// Field modulus
		"field_modulus": "21888242871839275222246405745257275088696311157297823662689037894645226208583",
		// Number of public inputs
		"num_public_inputs": 1,
		// Proof size in bytes
		"proof_size": 256,
	}
}

// ComputeProofHash computes SHA-256 hash of proof for commitment
func ComputeProofHash(proof *plonk_bn254.Proof) [32]byte {
	// Serialize proof
	data := make([]byte, 0)
	data = append(data, proof.OpeningProof.H...)

	// Compute hash
	hash := sha256.Sum256(data)
	return hash
}
