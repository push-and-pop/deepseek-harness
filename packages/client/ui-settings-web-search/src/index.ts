/**
 * Web-search and web-fetch settings pages, node half. The empty apply exists
 * so the plugin appears in the host cordis.yml / Loader; the browser half owns
 * the pages through exports["./client"], discovered from the package.json
 * dsh.client declaration. The `web-search-deepseek` namespace the search page
 * edits is registered by the search provider, and the `web-fetch-http`
 * namespace the fetch page edits by the fetch provider, so this package
 * registers no namespace of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
