interface SemVer {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

function parseSemVer(version: string): SemVer {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) throw new Error(`Invalid semver: "${version}"`);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function gte(a: SemVer, b: SemVer): boolean {
	if (a.major !== b.major) return a.major > b.major;
	if (a.minor !== b.minor) return a.minor > b.minor;
	return a.patch >= b.patch;
}

export function isApiVersionCompatible(range: string, kernelVersion: string): boolean {
	if (range === "*") return true;

	const kernel = parseSemVer(kernelVersion);

	if (range.startsWith("^")) {
		const min = parseSemVer(range.slice(1));
		if (!gte(kernel, min)) return false;
		if (min.major === 0) {
			return kernel.major === 0 && kernel.minor === min.minor;
		}
		return kernel.major === min.major;
	}

	if (range.startsWith("~")) {
		const min = parseSemVer(range.slice(1));
		if (!gte(kernel, min)) return false;
		return kernel.major === min.major && kernel.minor === min.minor;
	}

	if (range.startsWith(">=")) {
		const min = parseSemVer(range.slice(2));
		return gte(kernel, min);
	}

	const exact = parseSemVer(range);
	return (
		kernel.major === exact.major && kernel.minor === exact.minor && kernel.patch === exact.patch
	);
}
