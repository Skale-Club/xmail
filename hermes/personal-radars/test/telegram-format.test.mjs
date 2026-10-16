import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function readPrompt(name) {
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8')
}

test('apartment alerts require a scannable Telegram card with a standalone link', () => {
  const prompt = readPrompt('apartment-prospecting')

  assert.match(prompt, /🏠 APARTMENT RADAR/)
  assert.match(prompt, /🚗 2 vagas confirmadas/)
  assert.match(prompt, /✅ Laundry in-unit \| Dishwasher/)
  assert.match(prompt, /🔗 <URL direto>/)
  assert.match(prompt, /linha em branco entre imóveis/)
  assert.match(prompt, /Não escreva introdução, conclusão, parágrafo corrido/)
})

test('job alerts require regional cards and standalone links', () => {
  const prompt = readPrompt('job-prospecting')

  assert.match(prompt, /💼 JOB RADAR/)
  assert.match(prompt, /📍 FLÓRIDA/)
  assert.match(prompt, /📍 MASSACHUSETTS/)
  assert.match(prompt, /🌎 REMOTO/)
  assert.match(prompt, /🔗 <URL direto>/)
  assert.match(prompt, /linha em branco entre vagas/)
})

test('weekly comparisons avoid wide Markdown tables on Telegram', () => {
  const apartment = readPrompt('apartment-comparison')
  const job = readPrompt('job-comparison')

  assert.match(apartment, /📊 COMPARATIVO DE MORADIA/)
  assert.match(job, /📊 COMPARATIVO DE EMPREGOS/)
  assert.match(apartment, /Não use tabela Markdown/)
  assert.match(job, /Não use tabela Markdown/)
  assert.match(apartment, /🔎 LEITURA DO CENÁRIO/)
  assert.match(job, /🔎 LEITURA DO CENÁRIO/)
})
