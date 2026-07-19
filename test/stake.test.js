import assert from 'node:assert/strict'
import test from 'node:test'

import { formatUsdc, parseUsdc } from '../src/stake.js'

test('parses arbitrary positive USDC amounts exactly', () => {
  assert.equal(parseUsdc('0.000001'), '1')
  assert.equal(parseUsdc('1'), '1000000')
  assert.equal(parseUsdc('42.123456'), '42123456')
  assert.equal(parseUsdc(' 5000000.75 '), '5000000750000')
})

test('accepts the settlement contract representation limit', () => {
  assert.equal(
    parseUsdc('79228162514264337593543.950335'),
    '79228162514264337593543950335',
  )
})

test('rejects invalid amounts', () => {
  for (const value of ['', '0', '-1', '1.0000001', '1e3', '1,000', '79228162514264337593543.950336']) {
    assert.throws(() => parseUsdc(value))
  }
})

test('formats every USDC decimal without rounding', () => {
  assert.equal(formatUsdc('1'), '0.000001')
  assert.equal(formatUsdc('1000000'), '1')
  assert.equal(formatUsdc('42123456'), '42.123456')
})
