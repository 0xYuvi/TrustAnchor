package circuits

import (
	"math/big"

	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/bits"
)

// GreaterThanCircuit implements secret > threshold using bit decomposition
// with range proof and sign enforcement to prevent field wraparound attacks
type GreaterThanCircuit struct {
	// Secret: the value to prove is greater than threshold
	SecretValue frontend.Variable `gnark:"secret,value"`

	// Public: the threshold to compare against
	Threshold frontend.Variable `gnark:"public,threshold"`
}

// Define implements circuit constraints using binary comparison
func (c *GreaterThanCircuit) Define(api frontend.API) error {
	// Compute difference: secretValue - threshold
	diff := api.Sub(c.SecretValue, c.Threshold)

	// === RANGE PROOF: Ensure no underflow ===
	// We prove that diff is in range [0, 2^64 - 1]
	// If diff is in this range, then secretValue >= threshold
	// If additionally diff != 0, then secretValue > threshold

	// Decompose diff into bits using bits.ToBinary
	diffBits := bits.ToBinary(api, diff, bits.WithNbBits(254))

	// Upper bits (63-253) must be zero for range proof
	// This proves no field wraparound occurred
	for i := 64; i < 254; i++ {
		api.AssertIsEqual(diffBits[i].Bit, frontend.Variable(0))
	}

	// === PROVE DIFF > 0 ===
	// At least one of the lower 64 bits must be 1
	// Use polynomial sum: if any bit is 1, result is non-zero
	isNonZero := api.IsZero(
		diffBits[0].Bit,
		diffBits[1].Bit,
		diffBits[2].Bit,
		diffBits[3].Bit,
		diffBits[4].Bit,
		diffBits[5].Bit,
		diffBits[6].Bit,
		diffBits[7].Bit,
		diffBits[8].Bit,
		diffBits[9].Bit,
		diffBits[10].Bit,
		diffBits[11].Bit,
		diffBits[12].Bit,
		diffBits[13].Bit,
		diffBits[14].Bit,
		diffBits[15].Bit,
		diffBits[16].Bit,
		diffBits[17].Bit,
		diffBits[18].Bit,
		diffBits[19].Bit,
		diffBits[20].Bit,
		diffBits[21].Bit,
		diffBits[22].Bit,
		diffBits[23].Bit,
		diffBits[24].Bit,
		diffBits[25].Bit,
		diffBits[26].Bit,
		diffBits[27].Bit,
		diffBits[28].Bit,
		diffBits[29].Bit,
		diffBits[30].Bit,
		diffBits[31].Bit,
		diffBits[32].Bit,
		diffBits[33].Bit,
		diffBits[34].Bit,
		diffBits[35].Bit,
		diffBits[36].Bit,
		diffBits[37].Bit,
		diffBits[38].Bit,
		diffBits[39].Bit,
		diffBits[40].Bit,
		diffBits[41].Bit,
		diffBits[42].Bit,
		diffBits[43].Bit,
		diffBits[44].Bit,
		diffBits[45].Bit,
		diffBits[46].Bit,
		diffBits[47].Bit,
		diffBits[48].Bit,
		diffBits[49].Bit,
		diffBits[50].Bit,
		diffBits[51].Bit,
		diffBits[52].Bit,
		diffBits[53].Bit,
		diffBits[54].Bit,
		diffBits[55].Bit,
		diffBits[56].Bit,
		diffBits[57].Bit,
		diffBits[58].Bit,
		diffBits[59].Bit,
		diffBits[60].Bit,
		diffBits[61].Bit,
		diffBits[62].Bit,
		diffBits[63].Bit,
	)

	// Assert isNonZero == 0 (meaning at least one bit is 1)
	api.AssertIsEqual(isNonZero, frontend.Variable(0))

	return nil
}

// NewGreaterThanCircuit creates a new circuit instance
func NewGreaterThanCircuit() *GreaterThanCircuit {
	return &GreaterThanCircuit{}
}

// Compile returns the compiled constraint system
func (c *GreaterThanCircuit) Compile() (frontend.CompiledConstraintSystem, error) {
	return frontend.Compile(
		curves.BN254,
		backend.PLONK,
		c,
		frontend.WithCapacity(1<<18),
	)
}

// GetPublicInputs returns the public inputs for witness creation
func (c *GreaterThanCircuit) GetPublicInputs() []string {
	return []string{"threshold"}
}

// GetSecretInputs returns the secret inputs for witness creation
func (c *GreaterThanCircuit) GetSecretInputs() []string {
	return []string{"value"}
}
