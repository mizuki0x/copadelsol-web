const USDC_SCALE = 1_000_000n
const MAX_CONTRACT_STAKE = 79_228_162_514_264_337_593_543_950_335n

export function parseUsdc(value) {
  const input = String(value).trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input)) {
    throw new Error('Enter a positive USDC amount with up to 6 decimal places.')
  }

  const [whole, fraction = ''] = input.split('.')
  const amount = BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, '0'))
  if (amount === 0n) {
    throw new Error('Stake must be greater than zero.')
  }
  if (amount > MAX_CONTRACT_STAKE) {
    throw new Error("That amount exceeds the settlement contract's numeric range.")
  }
  return amount.toString()
}

export function formatUsdc(value) {
  const amount = BigInt(value)
  const whole = amount / USDC_SCALE
  const fraction = (amount % USDC_SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString()
}
