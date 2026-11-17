/**
 * The launcher puts the code in a fragment. Consume it without putting it into browser storage.
 * @param {string} hash Route fragment
 * @returns {string} Private installation code, if present
 */
export function setupCodeFromLink(hash) {
    return hash.match(/^#code=([A-Za-z0-9_-]{32})$/)?.[1] || "";
}
