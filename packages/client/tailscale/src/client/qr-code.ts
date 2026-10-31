/** Local QR encoding; no network request or persistent copy of the login URL. */
import qrcode from 'qrcode-generator'

/** Square SVG geometry, including the required four-module quiet zone. */
export interface LinkQr {
  readonly size: number
  readonly path: string
}

/** Encode a login URL as UTF-8 in a medium-error-correction QR code.
 * @param url The current authenticated link, retained only by the caller.
 * @returns Numeric SVG geometry, or undefined if the QR payload cannot fit.
 */
export function makeLinkQr(url: string): LinkQr | undefined {
  const bytes = new TextEncoder().encode(url)
  // QR version 40 at level M permits at most 2331 bytes in byte mode.
  if (bytes.length === 0 || bytes.length > 2331) return undefined
  const qr = qrcode(0, 'M')
  try {
    qr.addData(String.fromCharCode(...bytes), 'Byte')
    qr.make()
  } catch (_error) {
    // Unsupported payloads get localized UI feedback; never log the login URL.
    return undefined
  }
  const modules = qr.getModuleCount()
  const path: string[] = []
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) path.push(`M${col + 4},${row + 4}h1v1h-1z`)
    }
  }
  return { size: modules + 8, path: path.join('') }
}
