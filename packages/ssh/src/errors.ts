/**
 * Error mapping — translate ssh2/SFTP errors onto node:fs-style errors.
 *
 * The bundled tools (`read_file`/`write_file`/`edit_file`) branch on
 * `(err as NodeJS.ErrnoException).code` (e.g. `"ENOENT"`). SFTP/ssh2 errors do
 * NOT carry that shape, so the `SshExecBackend` routes every throw through this
 * mapping first. Pure: input → output, no I/O, zero mocks (plan §4.3).
 *
 * ssh2 SFTP status codes (RFC 4254 §9.1) → node:fs errno mapping, mirroring how
 * OpenSSH's own sftp client and node:fs classify the same conditions. Only the
 * cases the tools actually react to are mapped; everything else becomes
 * `EIO`-ish (a generic I/O error) so the tool's generic catch still works.
 */

/** A node:fs-style error carrying a `.code` errno string. */
export interface FsError extends Error {
	readonly code: string;
}

/** Build a node:fs-style error with a `.code`. Pure. */
export function fsError(code: string, message: string): FsError {
	const err = new Error(message) as FsError;
	(err as { code: string }).code = code;
	return err;
}

/**
 * Map a numeric SFTP status code (SSH_FXP_*) onto a node:fs errno string.
 * Returns `undefined` when the code has no meaningful errno analog (caller
 * falls back to a generic I/O error). Pure.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc4254#section-9.1
 */
export function sftpStatusToErrno(status: number): string | undefined {
	// SSH_FX_NO_SUCH_FILE (3) → ENOENT — the common case (missing path).
	if (status === 3) return "ENOENT";
	// SSH_FX_PERMISSION_DENIED (4) → EACCES — read/parse this path.
	if (status === 4) return "EACCES";
	// SSH_FX_FILE_ALREADY_EXISTS (11) → EEXIST.
	if (status === 11) return "EEXIST";
	// SSH_FX_NOT_A_DIRECTORY (20) → ENOTDIR.
	if (status === 20) return "ENOTDIR";
	return undefined;
}

/**
 * Normalize a ssh2/SFTP error into a node:fs-style `FsError`. Inspects the
 * ssh2 error's `code` (an SSH_FXP_* status string like `"SFTP_NO_SUCH_FILE"`
 * or a numeric `.code`/`.desc`) and maps it. Anything unrecognized → `EIO`.
 *
 * ssh2 surfaces SFTP failures two ways depending on the operation:
 *  - callback `err` whose `.code` is an `"SFTP_*"` status string, OR a numeric
 *    code on the error object;
 *  - `sftp.exists(cb)` which gives no error — handled separately by the caller.
 *
 * Pure: takes the thrown value, returns an `FsError`. Never throws.
 */
export function mapSshError(err: unknown, context: string): FsError {
	const message = err instanceof Error ? err.message : String(err);

	// ssh2 SFTP errors often carry a `.code` that is an SSH_FXP_* string.
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string") {
		const mapped = sshCodeStringToErrno(code);
		if (mapped !== undefined) return fsError(mapped, `${context}: ${message}`);
		// ssh2 also surfaces raw numeric SFTP status on `.code`.
	}
	if (typeof code === "number") {
		const mapped = sftpStatusToErrno(code);
		if (mapped !== undefined) return fsError(mapped, `${context}: ${message}`);
	}

	// Some ssh2 errors embed the SFTP status code as `.desc`/message text; sniff
	// the human-readable text for the common markers as a last resort.
	if (message.includes("No such file") || message.includes("ENOENT")) {
		return fsError("ENOENT", `${context}: ${message}`);
	}
	if (message.includes("Permission denied") || message.includes("EACCES")) {
		return fsError("EACCES", `${context}: ${message}`);
	}
	if (message.includes("not a directory") || message.includes("ENOTDIR")) {
		return fsError("ENOTDIR", `${context}: ${message}`);
	}

	// Host-key / connect failures are surfaced as ECONNREFUSED-ish so the tool's
	// generic error path still renders them clearly. Default: generic I/O error.
	if (message.includes("HOST KEY CHANGED") || message.includes("host key")) {
		return fsError("EHOSTUNREACH", `${context}: ${message}`);
	}
	return fsError("EIO", `${context}: ${message}`);
}

/**
 * Map an ssh2 `"SFTP_*"` status-code string (e.g. `"SFTP_STATUS_NO_SUCH_FILE"`,
 * `"NO_SUCH_FILE"`) onto a node:fs errno. ssh2's exact string spelling varies
 * across versions, so match case-insensitively on the stable fragment.
 * Returns `undefined` when no analog. Pure.
 */
function sshCodeStringToErrno(code: string): string | undefined {
	const c = code.toUpperCase();
	if (c.includes("NO_SUCH_FILE")) return "ENOENT";
	if (c.includes("PERMISSION_DENIED")) return "EACCES";
	if (
		c.includes("FILE_ALREADY_EXISTS") ||
		(c.includes("FAILURE") === false && c.includes("EXIST"))
	) {
		return "EEXIST";
	}
	if (c.includes("NOT_A_DIRECTORY")) return "ENOTDIR";
	return undefined;
}
