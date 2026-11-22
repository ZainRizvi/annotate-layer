/**
 * Sends the layer's HTTP requests to the host's annotations endpoint.
 * @external Annotations REST endpoint (HTTPS, fetch): lists, creates and closes notes
 */

/** The shape of the global `fetch`; the `fetch` option of the client has this type. */
export type FetchFunction = typeof fetch;

/** The global `fetch`, looked up on each call so a host or test that replaces it is honoured. */
export const fetchTransport: FetchFunction = (input, init) => fetch(input, init);
