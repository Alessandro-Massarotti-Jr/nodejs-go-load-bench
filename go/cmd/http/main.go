package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/alessandro/bench-go/internal/work"
)

// Entrada fixa: toda requisição calcula o mesmo hash (mesmo valor do projeto Node).
var hashInput = []byte("go-vs-node-benchmark")

type response struct {
	Message string `json:"message"`
	Data    data   `json:"data"`
}

type data struct {
	Result string `json:"result"`
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	iterations := work.Iterations()

	mux := http.NewServeMux()
	// "GET /{$}" casa somente com a raiz exata.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response{
			Message: "Finished!",
			Data:    data{Result: work.Hash(hashInput, iterations)},
		})
	})

	log.Printf("servidor Go rodando em http://localhost:%s (HASH_ITERATIONS=%d)", port, iterations)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
