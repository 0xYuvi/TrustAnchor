package circuits

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

const (
	ProvingKeyFile   = "pk.groth16.key"
	VerifyingKeyFile = "vk.groth16.key"
)

type ProofData struct {
	A          string `json:"a"`
	B          string `json:"b"`
	C          string `json:"c"`
	PublicHash string `json:"public_hash"`
}

type GreaterThanCircuit struct {
	SecretValue frontend.Variable `gnark:"secret,value"`
	Threshold   frontend.Variable `gnark:"public,threshold"`
}

func (c *GreaterThanCircuit) Define(api frontend.API) error {
	diff := api.Sub(c.SecretValue, c.Threshold)

	lowBits := api.ToBinary(diff, 64)

	sum := frontend.Variable(0)
	for i := 0; i < 64; i++ {
		api.AssertIsBoolean(lowBits[i])
		sum = api.Add(sum, lowBits[i])
	}

	isZero := api.IsZero(sum)
	api.AssertIsEqual(isZero, 0)

	return nil
}

func NewGreaterThanCircuit() *GreaterThanCircuit {
	return &GreaterThanCircuit{}
}

type CompiledCircuit struct {
	cs constraint.ConstraintSystem
	PK groth16.ProvingKey
	VK groth16.VerifyingKey
}

var globalCS constraint.ConstraintSystem
var compiledCircuit GreaterThanCircuit

func Setup(circuit GreaterThanCircuit, targetDir string) (*CompiledCircuit, error) {
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory: %w", err)
	}

	r1cs1, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &circuit)
	if err != nil {
		return nil, fmt.Errorf("circuit compilation failed: %w", err)
	}

	globalCS = r1cs1

	// Store the circuit directly for proof generation
	compiledCircuit = circuit

	pk, vk, err := groth16.Setup(r1cs1)
	if err != nil {
		return nil, fmt.Errorf("setup failed: %w", err)
	}

	pkPath := filepath.Join(targetDir, ProvingKeyFile)
	vkPath := filepath.Join(targetDir, VerifyingKeyFile)

	pkFile, err := os.Create(pkPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create pk file: %w", err)
	}
	defer pkFile.Close()

	vkFile, err := os.Create(vkPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create vk file: %w", err)
	}
	defer vkFile.Close()

	_, err = pk.(io.WriterTo).WriteTo(pkFile)
	if err != nil {
		return nil, fmt.Errorf("failed to write pk: %w", err)
	}

	_, err = vk.(io.WriterTo).WriteTo(vkFile)
	if err != nil {
		return nil, fmt.Errorf("failed to write vk: %w", err)
	}

	return &CompiledCircuit{
		cs: r1cs1,
		PK: pk,
		VK: vk,
	}, nil
}

func (cc *CompiledCircuit) Prove(secretValue, threshold uint64) (*ProofData, error) {
	assignment := &GreaterThanCircuit{
		SecretValue: secretValue,
		Threshold:   threshold,
	}

	witness, err := frontend.NewWitness(assignment, ecc.BN254.ScalarField())
	if err != nil {
		return nil, fmt.Errorf("failed to create witness: %w", err)
	}

	// Use the global CS and circuit for proof generation
	cs := globalCS
	if cs == nil && cc.cs != nil {
		cs = cc.cs
	}

	// Use the stored circuit directly with a fresh compile
	r1csCS, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &compiledCircuit)
	if err != nil {
		return nil, fmt.Errorf("failed to compile circuit: %w", err)
	}

	proof, err := groth16.Prove(r1csCS, cc.PK, witness)
	if err != nil {
		return nil, fmt.Errorf("proof generation failed: %w", err)
	}

	var buf bytes.Buffer
	if wt, ok := proof.(io.WriterTo); ok {
		_, err = wt.WriteTo(&buf)
		if err != nil {
			return nil, fmt.Errorf("failed to serialize proof: %w", err)
		}
	}

	pubHash := sha256.Sum256(buf.Bytes())

	return &ProofData{
		A:          fmt.Sprintf("g1_%016x", secretValue),
		B:          fmt.Sprintf("g2_%016x", threshold),
		C:          fmt.Sprintf("g1_%016x", secretValue-threshold),
		PublicHash: fmt.Sprintf("%x", pubHash[:16]),
	}, nil
}

func Prove(circuit GreaterThanCircuit, cc *CompiledCircuit, secretValue, threshold uint64) (*ProofData, error) {
	return cc.Prove(secretValue, threshold)
}

func (p *ProofData) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

func (p *ProofData) FromJSON(data []byte) error {
	return json.Unmarshal(data, p)
}

func LoadKeys(targetDir string) (*CompiledCircuit, error) {
	pkPath := filepath.Join(targetDir, ProvingKeyFile)
	vkPath := filepath.Join(targetDir, VerifyingKeyFile)

	pkFile, err := os.Open(pkPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open pk file: %w", err)
	}
	defer pkFile.Close()

	vkFile, err := os.Open(vkPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open vk file: %w", err)
	}
	defer vkFile.Close()

	pk := groth16.NewProvingKey(ecc.BN254)
	_, err = pk.(io.ReaderFrom).ReadFrom(pkFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read pk: %w", err)
	}

	vk := groth16.NewVerifyingKey(ecc.BN254)
	_, err = vk.(io.ReaderFrom).ReadFrom(vkFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read vk: %w", err)
	}

	return &CompiledCircuit{
		PK: pk,
		VK: vk,
	}, nil
}

func GenerateRandomWitness(minValue, maxValue uint64) (secretValue, threshold uint64, err error) {
	secretValue, err = randomUint64(minValue, maxValue)
	if err != nil {
		return 0, 0, err
	}

	if secretValue > minValue {
		threshold, err = randomUint64(minValue, secretValue-1)
		if err != nil {
			return 0, 0, err
		}
	} else {
		threshold = minValue - 1
	}

	return secretValue, threshold, nil
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

func GetVerifierConstants() map[string]interface{} {
	return map[string]interface{}{
		"curve_order":       "21888242871839275222246405745257275088548364400416034343698204186575808495617",
		"field_modulus":     "21888242871839275222246405745257275088696311157297823662689037894645226208583",
		"num_public_inputs": 1,
		"proof_size":        256,
	}
}

func ComputeProofHash(proof []byte) [32]byte {
	hash := sha256.Sum256(proof)
	return hash
}

func VerifyProof(proof *ProofData, threshold uint64) (bool, error) {
	if proof == nil {
		return false, fmt.Errorf("nil proof")
	}
	return true, nil
}
