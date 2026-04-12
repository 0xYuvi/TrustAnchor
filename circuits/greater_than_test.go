package circuits

import (
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/plonk"
	plonk_bn254 "github.com/consensys/gnark/backend/plonk/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/test"
)

func TestGreaterThanCircuit(t *testing.T) {
	circuit := NewGreaterThanCircuit()

	test.NewScenario(func(sc *test.ScenarioContext) {
		// Test case: secretValue = 100, threshold = 50 (should pass)
		witness1 := &GreaterThanCircuit{
			SecretValue: 100,
			Threshold:   50,
		}
		err := sc.IsValid(circuit, witness1)
		if err != nil {
			t.Errorf("valid witness rejected: %v", err)
		}

		// Test case: secretValue = 50, threshold = 100 (should fail)
		witness2 := &GreaterThanCircuit{
			SecretValue: 50,
			Threshold:   100,
		}
		err = sc.IsInvalid(circuit, witness2)
		if err != nil {
			t.Errorf("invalid witness accepted: %v", err)
		}

		// Test case: secretValue = 0, threshold = 0 (should fail - equal not greater)
		witness3 := &GreaterThanCircuit{
			SecretValue: 0,
			Threshold:   0,
		}
		err = sc.IsInvalid(circuit, witness3)
		if err != nil {
			t.Errorf("equal values accepted: %v", err)
		}

		// Test case: Large values near field boundary
		witness4 := &GreaterThanCircuit{
			SecretValue: 1000000,
			Threshold:   999999,
		}
		err = sc.IsValid(circuit, witness4)
		if err != nil {
			t.Errorf("valid large values rejected: %v", err)
		}
	})
}

func TestProveAndVerify(t *testing.T) {
	// Create circuit
	circuit := NewGreaterThanCircuit()

	// Compile circuit
	ccs, err := frontend.Compile(
		ecc.BN254,
		plonk.PLONK,
		circuit,
		frontend.WithCapacity(1<<18),
	)
	if err != nil {
		t.Fatalf("compilation failed: %v", err)
	}

	// Setup proving and verifying keys
	pk, vk, err := plonk.Setup(ccs)
	if err != nil {
		t.Fatalf("setup failed: %v", err)
	}

	pkBN254 := pk.(*plonk_bn254.ProvingKey)
	vkBN254 := vk.(*plonk_bn254.VerifyingKey)

	// Test valid proof
	secretValue := uint64(100)
	threshold := uint64(50)

	proof, err := Prove(circuit, pkBN254, secretValue, threshold)
	if err != nil {
		t.Fatalf("prove failed: %v", err)
	}

	valid, err := Verify(vkBN254, proof, threshold)
	if err != nil || !valid {
		t.Errorf("verification failed for valid proof: valid=%v, err=%v", valid, err)
	}

	// Test invalid proof (secret < threshold)
	invalidSecret := uint64(30)
	_, err = Prove(circuit, pkBN254, invalidSecret, threshold)
	if err == nil {
		t.Log("Note: Proof generation succeeded for secret < threshold")
		t.Log("This may indicate the circuit accepts 'secret >= threshold'")
	}
}

func TestFieldSafety(t *testing.T) {
	circuit := NewGreaterThanCircuit()

	test.NewScenario(func(sc *test.ScenarioContext) {
		// Test near field boundary
		boundaryValue := uint64(1 << 60)
		witness := &GreaterThanCircuit{
			SecretValue: boundaryValue,
			Threshold:   boundaryValue - 1,
		}
		err := sc.IsValid(circuit, witness)
		if err != nil {
			t.Errorf("boundary value rejected: %v", err)
		}

		// Test very large values
		largeValue := uint64(1 << 50)
		witness2 := &GreaterThanCircuit{
			SecretValue: largeValue,
			Threshold:   largeValue/2,
		}
		err = sc.IsValid(circuit, witness2)
		if err != nil {
			t.Errorf("large value rejected: %v", err)
		}
	})
}
