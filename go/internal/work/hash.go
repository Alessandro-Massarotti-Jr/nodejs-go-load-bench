// Package work concentra a carga de CPU usada no benchmark.
package work

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
)

// Iterations lê HASH_ITERATIONS (padrão 1000); o mesmo valor é usado no projeto Node.
func Iterations() int {
	if n, err := strconv.Atoi(os.Getenv("HASH_ITERATIONS")); err == nil && n > 0 {
		return n
	}
	return 1000
}

// Hash aplica SHA-256 n vezes encadeadas sobre input e retorna o hex do resultado.
func Hash(input []byte, n int) string {
	sum := sha256.Sum256(input)
	for i := 1; i < n; i++ {
		sum = sha256.Sum256(sum[:])
	}
	return hex.EncodeToString(sum[:])
}
