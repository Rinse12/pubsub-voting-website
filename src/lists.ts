import { z } from "zod";

/**
 * Runtime reads of the canonical 5chan directory registry:
 * https://github.com/bitsocialnet/lists/tree/master/5chan-directories
 *
 * Two kinds of files live there, both fetched straight off raw.githubusercontent.com
 * (CORS-open) so a merged PR shows up on the site without a redeploy:
 *   - 5chan-directories-defaults.json — display metadata per directory code (title,
 *     expected UX features, rules). Display-only here: the CONTESTS come from the
 *     generated manifest (shared/directory-manifest.ts), not from this file.
 *   - 5chan-<code>-directory.json — the registered candidate boards competing for that
 *     directory code (anyone can PR their board in). The site offers these as one-click
 *     vote targets; a directory with no file simply has no registered candidates yet.
 *
 * Everything here is best-effort: a fetch failure degrades the UI (no candidate list, no
 * rules panel) but never blocks voting — the tally and the new-board form don't need it.
 */

const RAW_BASE = "https://raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directories";

const DirectoryMetaSchema = z.object({
    directoryCode: z.string(),
    title: z.string(),
    features: z.record(z.string(), z.unknown()).optional(),
    rules: z.array(z.string()).optional()
});
export type DirectoryMeta = z.infer<typeof DirectoryMetaSchema>;

const DefaultsFileSchema = z.object({ directories: z.record(z.string(), DirectoryMetaSchema) });

const CandidateSchema = z.object({
    /** The board's .bso name when it has one, else its publicKey again. */
    address: z.string(),
    publicKey: z.string(),
    addedAt: z.number().optional(),
    owner: z.string().optional()
});
export type Candidate = z.infer<typeof CandidateSchema>;

const CandidateFileSchema = z.object({ boards: z.array(CandidateSchema) });

/** Display metadata for every directory code, keyed by code; {} on fetch failure. */
export async function fetchDirectoryMeta(): Promise<Record<string, DirectoryMeta>> {
    const res = await fetch(`${RAW_BASE}/5chan-directories-defaults.json`);
    if (!res.ok) throw new Error(`directory defaults fetch failed: ${res.status}`);
    return DefaultsFileSchema.parse(await res.json()).directories;
}

/** The registered candidate boards for one directory code; [] when the file doesn't exist (no candidates yet). */
export async function fetchCandidates(code: string): Promise<Candidate[]> {
    const res = await fetch(`${RAW_BASE}/5chan-${code}-directory.json`);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`candidate list fetch failed: ${res.status}`);
    return CandidateFileSchema.parse(await res.json()).boards;
}
