import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { makeLinkQr, type LinkQr } from '../src/client/qr-code.ts'

function decode(qr: LinkQr): string | undefined {
  const scale = 5
  const width = qr.size * scale
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
  const squares = [...qr.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)]
  expect(squares.map(match => match[0]).join('')).toBe(qr.path)
  for (const match of squares) {
    const col = Number(match[1])
    const row = Number(match[2])
    expect(col).toBeGreaterThanOrEqual(4)
    expect(row).toBeGreaterThanOrEqual(4)
    expect(col).toBeLessThan(qr.size - 4)
    expect(row).toBeLessThan(qr.size - 4)
    for (let y = row * scale; y < (row + 1) * scale; y++) {
      for (let x = col * scale; x < (col + 1) * scale; x++) {
        const offset = (y * width + x) * 4
        pixels[offset] = 0
        pixels[offset + 1] = 0
        pixels[offset + 2] = 0
      }
    }
  }
  return jsQR(pixels, width, width, { inversionAttempts: 'dontInvert' })?.data
}

describe('local login QR encoding', () => {
  it.each([
    'https://pc.example.ts.net:8443/?token=secret-token_0123456789-ABCDEFGHIJ',
    `https://${'a'.repeat(63)}.${'b'.repeat(63)}.ts.net:8443/?token=${'a'.repeat(43)}`,
    'https://pc.example.ts.net:8443/?token=abc&note=手机',
  ])('decodes the SVG geometry to the exact URL: %s', (url) => {
    const qr = makeLinkQr(url)
    expect(qr).toBeDefined()
    if (qr === undefined) throw new Error('fixture did not fit')
    expect(decode(qr)).toBe(url)
    expect(qr.path).not.toContain(url)
  })

  it('regenerates from the current token without retaining a prior link', () => {
    const first = makeLinkQr('https://pc.example.ts.net/?token=first')
    const second = makeLinkQr('https://pc.example.ts.net/?token=second')
    if (first === undefined || second === undefined) throw new Error('fixture did not fit')
    expect(second.path).not.toBe(first.path)
    expect(decode(second)).toBe('https://pc.example.ts.net/?token=second')
  })

  it('refuses empty or oversized payloads without publishing QR geometry', () => {
    expect(makeLinkQr('')).toBeUndefined()
    expect(makeLinkQr('x'.repeat(2332))).toBeUndefined()
  })
})
