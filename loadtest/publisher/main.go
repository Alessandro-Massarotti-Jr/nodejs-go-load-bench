// Publicador de carga para os listeners.
//
//	MODE=burst: publica COUNT mensagens o mais rápido possível.
//	MODE=rate:  publica RATE msg/s durante DURATION.
//
// Ao final imprime um resumo JSON entre os marcadores @@SUMMARY@@ e @@END@@.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const batchSize = 500

type summary struct {
	Mode      string    `json:"mode"`
	Queue     string    `json:"queue"`
	Published int       `json:"published"`
	Start     time.Time `json:"start"`
	End       time.Time `json:"end"`
	Seconds   float64   `json:"seconds"`
	Rate      float64   `json:"ratePerSecond"`
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return n
	}
	return fallback
}

type publisher struct {
	ch      *amqp.Channel
	queue   string
	n       int
	pending []*amqp.DeferredConfirmation
}

// publish envia uma mensagem; a cada batchSize aguarda as confirmações do broker.
func (p *publisher) publish(ctx context.Context) {
	p.n++
	body, _ := json.Marshal(map[string]string{"message": fmt.Sprintf("msg-%d", p.n)})
	dc, err := p.ch.PublishWithDeferredConfirmWithContext(ctx, "", p.queue, false, false,
		amqp.Publishing{ContentType: "application/json", Body: body})
	if err != nil {
		log.Fatalf("erro ao publicar: %v", err)
	}
	p.pending = append(p.pending, dc)
	if len(p.pending) >= batchSize {
		p.flush()
	}
}

func (p *publisher) flush() {
	for _, dc := range p.pending {
		if !dc.Wait() {
			log.Fatal("mensagem rejeitada pelo broker")
		}
	}
	p.pending = p.pending[:0]
}

func main() {
	mode := env("MODE", "burst")
	queue := env("QUEUE", "go-queue")

	conn, err := amqp.Dial(env("AMQP_URL", "amqp://admin:admin@localhost:5672/"))
	if err != nil {
		log.Fatalf("erro ao conectar: %v", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		log.Fatalf("erro ao abrir canal: %v", err)
	}
	if err := ch.Confirm(false); err != nil {
		log.Fatalf("erro ao ativar confirmações: %v", err)
	}
	if _, err := ch.QueueDeclare(queue, true, false, false, false, nil); err != nil {
		log.Fatalf("erro ao declarar fila: %v", err)
	}

	ctx := context.Background()
	p := &publisher{ch: ch, queue: queue}
	start := time.Now()

	switch mode {
	case "burst":
		count := envInt("COUNT", 100000)
		for i := 0; i < count; i++ {
			p.publish(ctx)
		}
	case "rate":
		rate := envInt("RATE", 500)
		duration := time.Duration(envInt("DURATION_SECONDS", 300)) * time.Second
		// Publica em fatias de 10ms para manter a taxa estável.
		tick := time.NewTicker(10 * time.Millisecond)
		defer tick.Stop()
		for now := range tick.C {
			elapsed := now.Sub(start)
			if elapsed >= duration {
				break
			}
			target := int(elapsed.Seconds() * float64(rate))
			for p.n < target {
				p.publish(ctx)
			}
		}
	default:
		log.Fatalf("MODE inválido: %s", mode)
	}
	p.flush()

	end := time.Now()
	s := summary{Mode: mode, Queue: queue, Published: p.n, Start: start, End: end,
		Seconds: end.Sub(start).Seconds()}
	s.Rate = float64(s.Published) / s.Seconds
	out, _ := json.Marshal(s)
	fmt.Printf("\n@@SUMMARY@@%s@@END@@\n", out)
}
