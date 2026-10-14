/** Source fixtures must behave identically under Git's LF and CRLF checkouts. */
export function normalizeSource(source) {
  return source.replace(/\r\n?/g, '\n');
}
