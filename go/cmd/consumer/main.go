package main

import (
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/alessandro/bench-go/internal/work"
	amqp "github.com/rabbitmq/amqp091-go"
)

const prefetch = 5

type payload struct {
	Message string `json:"message"`
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// handle processa uma mensagem; roda em sua própria goroutine.
func handle(d amqp.Delivery, iterations int) {
	var p payload
	if err := json.Unmarshal(d.Body, &p); err != nil {
		log.Printf("mensagem inválida: %v", err)
		d.Nack(false, false)
		return
	}

	log.Printf("mensagem recebida: %s hash=%s", p.Message, work.Hash([]byte(p.Message), iterations))
	d.Ack(false)
}

func main() {
	url := getEnv("AMQP_URL", "amqp://guest:guest@localhost:5672/")
	queue := getEnv("QUEUE", "go-queue")
	iterations := work.Iterations()

	conn, err := amqp.Dial(url)
	if err != nil {
		log.Fatalf("erro ao conectar no RabbitMQ: %v", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		log.Fatalf("erro ao abrir canal: %v", err)
	}
	defer ch.Close()

	if _, err := ch.QueueDeclare(queue, true, false, false, false, nil); err != nil {
		log.Fatalf("erro ao declarar fila: %v", err)
	}

	// No máximo 5 mensagens não confirmadas em voo ao mesmo tempo.
	if err := ch.Qos(prefetch, 0, false); err != nil {
		log.Fatalf("erro ao definir prefetch: %v", err)
	}

	deliveries, err := ch.Consume(queue, "", false, false, false, false, nil)
	if err != nil {
		log.Fatalf("erro ao consumir fila: %v", err)
	}

	log.Printf("consumer Go ouvindo a fila %q (prefetch=%d, HASH_ITERATIONS=%d)", queue, prefetch, iterations)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	for {
		select {
		case d, ok := <-deliveries:
			if !ok {
				// Conexão/canal fechado: sai com erro para o orquestrador reiniciar.
				log.Fatal("canal de entregas fechado")
			}
			go handle(d, iterations)
		case <-stop:
			log.Println("encerrando consumer")
			return
		}
	}
}
