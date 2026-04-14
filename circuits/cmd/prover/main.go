package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/trustanchor/circuits"
)

func main() {
	proveCmd := flag.NewFlagSet("prove", flag.ExitOnError)
	verifyCmd := flag.NewFlagSet("verify", flag.ExitOnError)
	setupCmd := flag.NewFlagSet("setup", flag.ContinueOnError)

	secret := proveCmd.Int("secret", 0, "Secret value to prove")
	threshold := proveCmd.Int("threshold", 0, "Threshold to prove against")
	pkPath := proveCmd.String("pk", "", "Path to proving key")
	outputPath := proveCmd.String("output", "", "Output file path (default: stdout)")

	verifyProof := verifyCmd.String("proof", "", "Proof to verify (base64)")
	verifyPublic := verifyCmd.String("public", "", "Public inputs (JSON)")
	vkPath := verifyCmd.String("vk", "", "Path to verifying key")

	setupDir := setupCmd.String("dir", "./keys", "Directory to save keys")

	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: prove | verify | setup")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "prove":
		proveCmd.Parse(os.Args[2:])
		if *secret == 0 || *threshold == 0 || *pkPath == "" {
			fmt.Fprintln(os.Stderr, "prove: --secret, --threshold, and --pk required")
			os.Exit(1)
		}
		runProve(*secret, *threshold, *pkPath, *outputPath)

	case "verify":
		verifyCmd.Parse(os.Args[2:])
		if *verifyProof == "" || *verifyPublic == "" || *vkPath == "" {
			fmt.Fprintln(os.Stderr, "verify: --proof, --public, and --vk required")
			os.Exit(1)
		}
		runVerify(*verifyProof, *verifyPublic, *vkPath)

	case "setup":
		setupCmd.Parse(os.Args[2:])
		runSetup(*setupDir)

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func runProve(secret, threshold int, pkPath, outputPath string) {
	cc, err := circuits.LoadKeys(filepath.Dir(pkPath))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to load keys:", err)
		os.Exit(1)
	}

	circuit := circuits.GreaterThanCircuit{}
	proof, err := circuits.Prove(circuit, cc, uint64(secret), uint64(threshold))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Proof generation failed:", err)
		os.Exit(1)
	}

	proofBytes, err := proof.ToJSON()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to marshal proof:", err)
		os.Exit(1)
	}

	result := map[string]interface{}{
		"proof":         string(proofBytes),
		"public_inputs": map[string]int{"threshold": threshold},
	}

	output, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to marshal result:", err)
		os.Exit(1)
	}

	if outputPath == "" || outputPath == "/dev/stdout" {
		fmt.Println(string(output))
	} else {
		if err := os.WriteFile(outputPath, output, 0644); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to write output:", err)
			os.Exit(1)
		}
	}
}

func runVerify(proofJSON, publicJSON, vkPath string) {
	var proofData circuits.ProofData
	if err := proofData.FromJSON([]byte(proofJSON)); err != nil {
		fmt.Fprintln(os.Stderr, "Invalid proof encoding:", err)
		os.Exit(1)
	}

	_, err := circuits.LoadKeys(filepath.Dir(vkPath))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to load keys:", err)
		os.Exit(1)
	}

	var public map[string]int
	if err := json.Unmarshal([]byte(publicJSON), &public); err != nil {
		fmt.Fprintln(os.Stderr, "Invalid public inputs:", err)
		os.Exit(1)
	}

	threshold := uint64(public["threshold"])

	valid, err := circuits.VerifyProof(&proofData, threshold)
	if err != nil {
		fmt.Fprintf(os.Stderr, `{"valid": false, "error": "%s"}`, err)
		os.Exit(1)
	}

	if valid {
		fmt.Println(`{"valid": true}`)
	} else {
		fmt.Println(`{"valid": false}`)
	}
}

func runSetup(dir string) {
	circuit := circuits.GreaterThanCircuit{}
	cc, err := circuits.Setup(circuit, dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Setup failed:", err)
		os.Exit(1)
	}

	fmt.Printf("Keys generated successfully!\n")
	fmt.Printf("Proving Key: %s\n", filepath.Join(dir, circuits.ProvingKeyFile))
	fmt.Printf("Verifying Key: %s\n", filepath.Join(dir, circuits.VerifyingKeyFile))

	_ = cc
}
