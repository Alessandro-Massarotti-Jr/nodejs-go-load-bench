import { hash as digest } from 'node:crypto';

// Lê HASH_ITERATIONS (padrão 1000); o mesmo valor é usado no projeto Go.
export function iterations() {
  const n = Number.parseInt(process.env.HASH_ITERATIONS, 10);
  return n > 0 ? n : 1000;
}

// Aplica SHA-256 n vezes encadeadas sobre input e retorna o hex do resultado.
// crypto.hash (one-shot) é o equivalente ao sha256.Sum256 do Go.
export function hash(input, n) {
  let sum = digest('sha256', input, 'buffer');
  for (let i = 1; i < n; i++) {
    sum = digest('sha256', sum, 'buffer');
  }
  return sum.toString('hex');
}
