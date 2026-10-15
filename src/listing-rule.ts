/**
 * Guard against large recursive listings.
 *
 * `ls -R` over a small directory prints less than a finder call would, so it is
 * left alone. Over a large tree it floods the context, and the file finder's
 * bounded, paged output is the better tool.
 */

import type { Dir } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

/** Above this many entries a recursive listing is blocked. */
export const MAX_LISTING_ENTRIES = 200;

/**
 * True when walking `directories` the way `ls -R` does finds more than
 * MAX_LISTING_ENTRIES entries. The walk stops as soon as the limit is passed,
 * does not follow symlinks, and skips unreadable directories.
 */
export async function isLargeListing(directories: string[], includeHidden: boolean): Promise<boolean> {
	const queue = [...directories];
	let entries = 0;
	while (queue.length > 0) {
		const directory = queue.shift() as string;
		let handle: Dir;
		try {
			handle = await opendir(directory);
		} catch {
			// Missing, unreadable or not a directory: ls reports it in one line.
			continue;
		}
		// Leaving the loop early closes the handle.
		for await (const entry of handle) {
			if (!includeHidden && entry.name.startsWith(".")) continue;
			entries += 1;
			if (entries > MAX_LISTING_ENTRIES) return true;
			if (entry.isDirectory()) queue.push(join(directory, entry.name));
		}
	}
	return false;
}
