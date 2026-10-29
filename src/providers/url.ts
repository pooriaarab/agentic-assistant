import { ProviderError } from "../types.js";

export function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Accepts https, or http on a loopback host. Returns the URL without a trailing slash. */
export function checkBaseUrl(baseUrl: string): { url: URL; text: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderError(`baseUrl is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new ProviderError("baseUrl must use https, except for localhost");
  }
  return { url, text: baseUrl.replace(/\/+$/, "") };
}
